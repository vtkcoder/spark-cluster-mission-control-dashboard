import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureSchema, upsertMeta, getMetaMap, addComment, getComments, logEvent, updateEvent, pool } from "./db";

const NODE = "spark1";
const MID = "__test__/db-model";

beforeAll(async () => {
  await ensureSchema();
  await pool.query("DELETE FROM model_meta WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_comment WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_event WHERE model_id LIKE '__test__/%'");
});

afterAll(async () => {
  await pool.query("DELETE FROM model_meta WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_comment WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_event WHERE model_id LIKE '__test__/%'");
  await pool.end();
});

describe("db meta", () => {
  it("upserts and reads metadata", async () => {
    const m = await upsertMeta(NODE, MID, { starred: true, tags: ["a", "b"], rating: 4, status: "keep" });
    expect(m.starred).toBe(true);
    expect(m.tags).toEqual(["a", "b"]);
    const map = await getMetaMap(NODE);
    expect(map[MID].rating).toBe(4);
  });

  it("merges patches without clobbering unset fields", async () => {
    await upsertMeta(NODE, MID, { notes: "hello" });
    const map = await getMetaMap(NODE);
    expect(map[MID].notes).toBe("hello");
    expect(map[MID].starred).toBe(true); // preserved from previous upsert
  });

  it("stores comments newest-last", async () => {
    await addComment(NODE, MID, "first");
    await addComment(NODE, MID, "second");
    const cs = await getComments(NODE, MID);
    expect(cs.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("logs and updates events", async () => {
    const id = await logEvent(NODE, MID, "backup", "started", { target: "/mnt/x" });
    await updateEvent(id, "success", { bytes: 123 });
    const { rows } = await pool.query("SELECT status, detail FROM model_event WHERE id=$1", [id]);
    expect(rows[0].status).toBe("success");
    expect(rows[0].detail.bytes).toBe(123);
  });
});
