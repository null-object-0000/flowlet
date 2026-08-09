import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/pages/models/ModelServicesPage.module.css"), "utf8");

describe("model services readability styles", () => {
  it("does not shrink business text below the 12px caption floor", () => {
    const pixelFontSizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));

    expect(pixelFontSizes.every((fontSize) => fontSize >= 12)).toBe(true);
  });

  it("uses only defined Flowlet text color tokens", () => {
    expect(css).not.toContain("--flowlet-color-text-primary");
  });
});
