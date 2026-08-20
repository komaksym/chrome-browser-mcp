// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { performPageAction } from "../../src/extension/actions.js";

describe("performPageAction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("clicks a uniquely named element", () => {
    document.body.innerHTML = '<button type="button">Apply now</button>';
    const button = document.querySelector("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    performPageAction({ action: "click", target: "Apply now" });

    expect(clicked).toHaveBeenCalledOnce();
  });

  it("types by associated label and dispatches form events", () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email">';
    const input = document.querySelector("input")!;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    performPageAction({ action: "type", target: "Email", text: "max@example.com" });

    expect(input.value).toBe("max@example.com");
    expect(events).toEqual(["input", "change"]);
  });

  it("selects an option by visible text", () => {
    document.body.innerHTML = `
      <select aria-label="Country">
        <option value="pl">Poland</option>
        <option value="de">Germany</option>
      </select>
    `;
    const select = document.querySelector("select")!;

    const result = performPageAction({ action: "select_option", target: "Country", value: "Poland" });

    expect(select.value).toBe("pl");
    expect(result).toMatchObject({ action: "select_option", value: "pl", text: "Poland" });
  });

  it("rejects ambiguous human-readable targets", () => {
    document.body.innerHTML = "<button>Save</button><button>Save</button>";

    expect(() => performPageAction({ action: "click", target: "Save" })).toThrow("AMBIGUOUS_TARGET");
  });

  it("allows empty text so a field can be cleared", () => {
    document.body.innerHTML = '<input aria-label="Search" value="old">';
    const input = document.querySelector("input")!;

    performPageAction({ action: "type", target: "Search", text: "" });

    expect(input.value).toBe("");
  });
});
