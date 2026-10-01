Deno.test("workflow defaults to analysis and guards the AI-only steps", async () => {
  const workflow = await Deno.readTextFile(
    new URL("./workflow.yaml", import.meta.url),
  );

  if (!workflow.includes("    analyze:\n      type: boolean\n")) {
    throw new Error("Expected the analyze boolean input");
  }
  if (!workflow.includes("      default: true\n  required:\n")) {
    throw new Error("Expected analyze to default to true");
  }

  for (const step of ["sanitize-evidence", "analyze-story"]) {
    const marker = `      - name: ${step}\n`;
    const start = workflow.indexOf(marker);
    if (start < 0) throw new Error(`Missing ${step} step`);
    const end = workflow.indexOf("\n      - name:", start + marker.length);
    const block = workflow.slice(start, end < 0 ? undefined : end);
    if (!block.includes("        guard: ${{ !inputs.analyze }}")) {
      throw new Error(`Expected analyze guard on ${step}`);
    }
  }
});
