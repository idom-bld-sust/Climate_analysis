import test from "node:test";
import assert from "node:assert/strict";
import { skyMatrices, radiationKey } from "../app/static/radiation3d/sky.js";

const sum = (values) => values.reduce((a, b) => a + b, 0);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < Math.max(1e-4, Math.abs(expected) * 1e-6),
  `${actual} != ${expected}`);
const epw = (lat, hours) => ({ lat, lon: 0, tz: 0, hours });
const hour = (month, h, overrides = {}) => ({ month, day: 21, hour: h, ghi: h * 2, dhi: h, dni: 0, ...overrides });

test("time bands filter diffuse and ground energy at exact clock boundaries, retaining daily totals", () => {
  const hours = Array.from({ length: 24 }, (_, i) => hour(6, i + 1));
  const { energies, nSky } = skyMatrices(epw(40, hours), 0, 0.2);
  // EPW end-hours 7..10 represent the four intervals from 06:00 to 10:00.
  for (const [band, selected] of [
    ["all", hours], ["morning", hours.slice(6, 10)], ["midday", hours.slice(11, 15)], ["afternoon", hours.slice(16, 20)],
  ]) {
    const values = energies[radiationKey("annual", band)];
    close(sum(values.slice(0, nSky)), 2 * sum(selected.map((h) => h.dhi)));
    close(sum(values.slice(nSky)), 2 * 0.2 * sum(selected.map((h) => h.ghi)));
    assert.deepEqual(values, energies[radiationKey("summer", band)]);
    close(sum(energies[radiationKey("winter", band)]), 0);
  }
  assert.ok(sum(energies.annual) > sum(energies.annual_morning) + sum(energies.annual_midday) + sum(energies.annual_afternoon));
});

test("direct radiation is partitioned by time and hemisphere without changing annual energy", () => {
  const hours = [6, 12, 3].flatMap((month) =>
    Array.from({ length: 24 }, (_, i) => hour(month, i + 1, { dni: 100 + i, dhi: 0, ghi: 0 })));
  const north = skyMatrices(epw(40, hours), 0, 0).energies;
  const south = skyMatrices(epw(-40, hours), 30, 0).energies;
  assert.equal(Object.keys(north).length, 12);
  for (const band of ["all", "morning", "midday", "afternoon"]) {
    const expected = hours.filter((h) => h.month === 12);
    const isolated = skyMatrices(epw(-40, expected), 30, 0).energies;
    assert.deepEqual(south[radiationKey("summer", band)], isolated[radiationKey("annual", band)]);
  }
  for (const [band, endHours] of [["morning", [7, 8, 9, 10]], ["midday", [12, 13, 14, 15]], ["afternoon", [17, 18, 19, 20]]]) {
    const isolated = skyMatrices(epw(40, hours.filter((h) => endHours.includes(h.hour))), 0, 0).energies;
    assert.deepEqual(north[radiationKey("annual", band)], isolated.annual);
  }
  const fullDay = skyMatrices(epw(40, [hour(6, 12, { dni: 750, dhi: 0, ghi: 0 })]), 0, 0).energies;
  close(sum(fullDay.annual), 750);
  assert.deepEqual(fullDay.annual, fullDay.annual_midday);
  close(sum(fullDay.annual_morning), 0);
  close(sum(fullDay.annual_afternoon), 0);
});

test("radiation worker returns all twelve results with the same visibility and kWh conversion", async () => {
  const messages = [];
  globalThis.self = { postMessage: (message) => messages.push(message) };
  try {
    await import("../app/static/radiation3d/worker.js");
    const energies = Object.fromEntries(Object.keys(skyMatrices(epw(40, []), 0, 0).energies)
      .map((key, i) => [key, new Float32Array([1000 * (i + 1), 250])]));
    const run = (tris) => {
      self.onmessage({ data: { type: "scene", tris: new Float32Array(tris) } });
      self.onmessage({ data: { type: "radiation", pts: new Float32Array([0, 0, 0]), nrm: new Float32Array([0, 0, 1]),
        dirs: new Float32Array([0, 0, 1, 0, 0, -1]), energies } });
      const message = messages.at(-1);
      assert.equal(message.type, "radiation-ok");
      return message.res;
    };
    const visible = run([]);
    for (const [i, key] of Object.keys(energies).entries()) close(visible[key][0], i + 1);
    const blocked = run([-10, -10, 1, 10, -10, 1, 0, 10, 1]);
    for (const values of Object.values(blocked)) close(values[0], 0);
  } finally { delete globalThis.self; }
});
