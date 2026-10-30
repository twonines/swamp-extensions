import { upsertRules } from "./mod.ts";

const r = (id: string, rule: string) => ({
  id,
  rule,
  why: "",
  addedAt: "t",
});

Deno.test("upsertRules adds new ids and replaces old ids", () => {
  const out = upsertRules([r("a", "old"), r("b", "keep")], [
    r("a", "new"),
    r("c", "added"),
  ]);
  if (out.map((x) => `${x.id}:${x.rule}`).join() !== "a:new,b:keep,c:added") {
    throw new Error(JSON.stringify(out));
  }
});
