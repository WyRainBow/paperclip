import { describe, expect, it } from "vitest";
import { t } from ".";
import en from "./locales/en.json";
import { localeMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("resolves English messages with key and default fallbacks", () => {
    expect(t("Create your first company")).toBe(en["Create your first company"]);
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
    expect(t("app.missing")).toBe("app.missing");
  });

  it("accepts registered locale files", () => {
    expect(Object.keys(localeMessages)).toContain("en");
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(validateLocaleMessages(messages), locale).toEqual([]);
    }
  });

  it("rejects missing and extra keys", () => {
    expect(
      validateLocaleMessages({
        "Create your first company": en["Create your first company"],
        unexpected: "Unexpected",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("is missing"),
        "unexpected is not defined in English",
      ]),
    );
  });

  it("rejects non-string leaves", () => {
    expect(
      validateLocaleMessages({
        "Create your first company": ["Create your first company"],
      }),
    ).toEqual(expect.arrayContaining(["Create your first company must be a string"]));
  });

  it("requires interpolation placeholders to match English", () => {
    const reference = {
      message: "Invite {{name}} to {{company}}",
    };

    expect(validateLocaleMessages({ message: "Invite {{name}}" }, reference)).toEqual([
      'message interpolation placeholders must match English exactly: expected ["company","name"], received ["name"]',
    ]);
  });

  it("rejects executable, raw HTML, and unexpected link payloads not present in English", () => {
    const reference = {
      script: "Create company",
      handler: "Create company",
      js: "Create company",
      data: "Create company",
      url: "Create company",
      html: "Create company",
    };

    expect(
      validateLocaleMessages(
        {
          script: "<script>alert(1)</script>",
          handler: '<span ONCLICK="alert(1)">Create</span>',
          js: "javascript:alert(1)",
          data: "data:text/html,hello",
          url: "https://example.test",
          html: "<strong>Create company</strong>",
        },
        reference,
      ),
    ).toEqual(
      expect.arrayContaining([
        "script contains disallowed <script",
        "handler contains disallowed event-handler attribute",
        "js contains disallowed javascript:",
        "data contains disallowed data:",
        "url contains disallowed unexpected URL",
        "html contains disallowed raw HTML tag",
      ]),
    );
  });

  it("caps localized string length relative to English", () => {
    expect(validateLocaleMessages({ message: "x".repeat(200) }, { message: "Short" })).toEqual([
      "message is too long: 200 characters exceeds 133",
    ]);
  });
});

// The app validates every shipped locale at module load and throws on the first
// mismatch, which blanks the whole UI before React mounts. Four such white
// screens shipped from editing zh-CN without adding the key to en.json, so pin
// the invariant here where it fails as a red test instead of a blank page.
describe("shipped locale catalog", () => {
  const catalog = import.meta.glob("./locales/*.json", { eager: true, import: "default" }) as Record<
    string,
    Record<string, unknown>
  >;

  function localeName(path: string) {
    return path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1] ?? path;
  }

  const english = Object.entries(catalog).find(([path]) => localeName(path) === "en")?.[1];

  it("ships an English catalog", () => {
    expect(english).toBeTruthy();
  });

  it.each(
    Object.entries(catalog)
      .map(([path, messages]) => [localeName(path), messages] as const)
      .filter(([locale]) => locale !== "en"),
  )("%s has exactly the English key set", (_locale, messages) => {
    const englishKeys = Object.keys(english ?? {}).sort();
    expect(Object.keys(messages).sort()).toEqual(englishKeys);
  });

  it.each(Object.entries(catalog).map(([path, messages]) => [localeName(path), messages] as const))(
    "%s passes the runtime validator",
    (_locale, messages) => {
      expect(validateLocaleMessages(messages, english)).toEqual([]);
    },
  );
});
