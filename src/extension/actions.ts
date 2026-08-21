export type PageAction =
  | { action: "click"; target: string }
  | { action: "type"; target: string; text: string }
  | { action: "press_key"; target?: string; key: string }
  | { action: "scroll"; deltaY: number }
  | { action: "select_option"; target: string; value: string };

export function performPageAction(action: PageAction) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

  const interactive = () =>
    Array.from(
      document.querySelectorAll(
        'button,a,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      ),
    ).filter((element): element is HTMLElement => element instanceof HTMLElement);

  const names = (element: HTMLElement) => {
    const values = [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("placeholder") ?? "",
      element.getAttribute("name") ?? "",
      element.textContent ?? "",
    ];
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const label = element.labels?.[0]?.textContent;
      if (label) values.push(label);
    }
    return values.map(normalize).filter(Boolean);
  };

  const resolveTarget = (target?: string): HTMLElement => {
    if (!target) {
      if (document.activeElement instanceof HTMLElement) return document.activeElement;
      return document.body;
    }

    let selectorMatches: HTMLElement[] = [];
    try {
      selectorMatches = Array.from(document.querySelectorAll(target)).filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
    } catch {
      // Not a CSS selector; fall back to human-readable element names.
    }
    const selectorMatch = selectorMatches[0];
    if (selectorMatches.length === 1 && selectorMatch) return selectorMatch;
    if (selectorMatches.length > 1) throw new Error(`AMBIGUOUS_TARGET: ${target}`);

    const wanted = normalize(target);
    const matches = interactive().filter((element) => names(element).includes(wanted));
    const match = matches[0];
    if (matches.length === 1 && match) return match;
    if (matches.length > 1) throw new Error(`AMBIGUOUS_TARGET: ${target}`);
    throw new Error(`TARGET_NOT_FOUND: ${target}`);
  };

  if (action.action === "scroll") {
    window.scrollBy({ top: action.deltaY, left: 0, behavior: "auto" });
    return { action: "scroll", deltaY: action.deltaY };
  }

  const element = resolveTarget(action.target);
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();

  if (action.action === "click") {
    element.click();
    return { action: "click", target: action.target, tag: element.tagName.toLocaleLowerCase() };
  }

  if (action.action === "type") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.disabled || element.readOnly) throw new Error(`NOT_EDITABLE: ${action.target}`);
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(element, action.text);
      else element.value = action.text;
    } else if (element.isContentEditable) {
      element.textContent = action.text;
    } else {
      throw new Error(`NOT_EDITABLE: ${action.target}`);
    }
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { action: "type", target: action.target, characters: action.text.length };
  }

  if (action.action === "select_option") {
    if (!(element instanceof HTMLSelectElement)) throw new Error(`NOT_SELECT: ${action.target}`);
    if (element.disabled) throw new Error(`NOT_EDITABLE: ${action.target}`);
    const wanted = normalize(action.value);
    const option = Array.from(element.options).find(
      (candidate) => candidate.value === action.value || normalize(candidate.text) === wanted,
    );
    if (!option) throw new Error(`OPTION_NOT_FOUND: ${action.value}`);
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { action: "select_option", target: action.target, value: option.value, text: option.text };
  }

  const eventInit = { key: action.key, bubbles: true, cancelable: true, composed: true };
  const allowed = element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  if (allowed && action.key === "Enter") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.form?.requestSubmit();
    else if (element instanceof HTMLButtonElement) element.click();
  } else if (allowed && action.key === "Escape") {
    element.blur();
  }
  element.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  return { action: "press_key", target: action.target ?? null, key: action.key };
}
