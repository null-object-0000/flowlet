import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  LongCatPackManager,
  parseLongCatPacks,
  summarizeLongCatPacks,
  toLongCatPackExpireAt,
} from "./LongCatPackManager";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

describe("LongCatPackManager", () => {
  it("parses currentLot and multiple otherLots and summarizes active packs", () => {
    const packs = parseLongCatPacks(JSON.stringify({
      code: 0,
      data: {
        currentLot: { lotId: 1, totalToken: 1000, consumedToken: 250, remainingToken: 750, expireTime: "2026-08-01T23:59:59", status: "ACTIVE" },
        otherLots: [
          { lotId: 2, totalToken: 2000, consumedToken: 500, remainingToken: 1500, expireTime: "2026-07-20T23:59:59", status: "ACTIVE" },
          { lotId: 3, totalToken: 999, remainingToken: 999, status: "EXPIRED" },
        ],
      },
    }));

    expect(packs).toHaveLength(3);
    expect(summarizeLongCatPacks(packs)).toEqual({ total: 3000, used: 750, remaining: 2250, expireAt: "2026-07-20T23:59:59" });
  });

  it("keeps imported calendar expiry dates stable without UTC rollover", () => {
    const packs = parseLongCatPacks(JSON.stringify({
      code: 0,
      data: {
        currentLot: { lotId: 151724, totalToken: 50_000_000, consumedToken: 22_071_022, remainingToken: 27_928_978, expireTime: "2026-07-30 01:00:31", status: "ACTIVE" },
        otherLots: [
          { lotId: 159869, totalToken: 10_000_000, consumedToken: 0, remainingToken: 10_000_000, expireTime: "2026-07-30 09:42:47", status: "ACTIVE" },
          { lotId: 160795, totalToken: 5_000_000, consumedToken: 0, remainingToken: 5_000_000, expireTime: "2026-07-30 11:48:49", status: "ACTIVE" },
        ],
      },
    }));

    expect(summarizeLongCatPacks(packs)).toEqual({
      total: 65_000_000,
      used: 22_071_022,
      remaining: 42_928_978,
      expireAt: "2026-07-30 01:00:31",
    });
    expect(toLongCatPackExpireAt("2026-07-30")).toBe("2026-07-30T23:59:59");
  });

  it("imports multiple packs, lets the user manage them, and saves the full list", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LongCatPackManager initialPacks={[]} onCancel={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText("LongCat 资源包 JSON"), { target: { value: JSON.stringify({
      data: {
        currentLot: { lotId: 11, totalToken: 100, remainingToken: 80, expireTime: "2026-09-01T23:59:59", status: "ACTIVE" },
        otherLots: [{ lotId: 12, totalToken: 200, remainingToken: 160, expireTime: "2026-08-01T23:59:59", status: "ACTIVE" }],
      },
    }) } });
    await user.click(screen.getByRole("button", { name: "导入 JSON" }));

    expect(screen.getByText(/共/).parentElement).toHaveTextContent("2");
    expect(screen.getByLabelText("资源包 1 到期时间")).toHaveValue("2026-08-01");
    await user.click(screen.getByRole("button", { name: "删除资源包 2" }));
    await user.click(screen.getByRole("button", { name: "保存资源包" }));

    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ lotId: 12 })]);
  });
});
