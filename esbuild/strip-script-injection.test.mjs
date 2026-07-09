import { describe, it, expect } from "vitest";
import {
	STRIP_FILTER,
	TEST_RE,
	BODY_RE,
	stripScriptInjectionSource,
} from "./strip-script-injection.mjs";

/** Count surviving `createElement("script")` / `createElement('script')` literals. */
function scriptCreateCount(src) {
	// Fresh regex per call — global regexes carry `lastIndex` state across .exec/.test.
	return (src.match(/createElement\((['"])script\1\)/g) || []).length;
}

// -- Fixtures: faithful shapes of the three culprit sources (trimmed to the
//    feature-detect + body, preserving quote style and receiver expression). --

// node_modules/immediate/lib/index.js — SINGLE quotes, `global.document` receiver.
const IMMEDIATE_SRC = `
} else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
  attachTo = global.document.documentElement;
  installReadyStateChangeImplementation = function () {
    var scriptEl = global.document.createElement('script');
    scriptEl.onreadystatechange = function () {
      handle();
      scriptEl.onreadystatechange = null;
      attachTo.removeChild(scriptEl);
      scriptEl = null;
    };
    attachTo.appendChild(scriptEl);
  };
} else {
`;

// node_modules/setimmediate/setImmediate.js — DOUBLE quotes, `doc` receiver.
const SETIMMEDIATE_SRC = `
    } else if (doc && "onreadystatechange" in doc.createElement("script")) {
        installReadyStateChangeImplementation();
    } else {
        var script = doc.createElement("script");
        script.onreadystatechange = function () {
            handle();
            script.onreadystatechange = null;
        };
    }
`;

// docx/dist/index.mjs — minified, DOUBLE quotes, single-char receiver `t2`.
const DOCX_MIN_SRC =
	`r="document" in t2 && "onreadystatechange" in t2.document.createElement("script")?function(){` +
	`var e3=t2.document.createElement("script");e3.onreadystatechange=function(){u(),e3.onreadystatechange=null,` +
	`e3.parentNode.removeChild(e3),e3=null},t2.document.documentElement.appendChild(e3)}:function(){setTimeout(u,0)};`;

describe("stripScriptInjectionSource", () => {
	const fixtures = [
		["immediate (single-quote, global.document)", IMMEDIATE_SRC],
		["setimmediate (double-quote, doc)", SETIMMEDIATE_SRC],
		["docx dist (minified, double-quote, t2.document)", DOCX_MIN_SRC],
	];

	for (const [name, src] of fixtures) {
		it(`reduces createElement("script") to 0 for ${name}`, () => {
			// Sanity: the fixture actually contains the pattern before transform.
			expect(scriptCreateCount(src)).toBeGreaterThan(0);

			const out = stripScriptInjectionSource(src);

			// The literal the Obsidian reviewer flags must be gone entirely.
			expect(scriptCreateCount(out)).toBe(0);
			// The feature-test is neutralized to a foldable `false`.
			expect(out).toContain("false");
			// Bodies are rewritten to a benign element, not deleted outright.
			expect(out).toContain('createElement("template")');
		});
	}

	it("is idempotent (safe to run twice with shared global regexes)", () => {
		const once = stripScriptInjectionSource(IMMEDIATE_SRC);
		const twice = stripScriptInjectionSource(once);
		expect(twice).toBe(once);
		expect(scriptCreateCount(twice)).toBe(0);
	});

	it("leaves unrelated source untouched", () => {
		const benign = `const el = doc.createElement("div"); el.onreadystatechange = null;`;
		expect(stripScriptInjectionSource(benign)).toBe(benign);
	});
});

describe("strip-script-injection filter/regex invariants", () => {
	it("STRIP_FILTER matches the three culprit module paths (posix + win32)", () => {
		const paths = [
			"/repo/node_modules/immediate/lib/index.js",
			"/repo/node_modules/setimmediate/setImmediate.js",
			"/repo/node_modules/docx/dist/index.mjs",
			"/repo/node_modules/docx/dist/index.cjs",
			"/repo/node_modules/docx/dist/index.umd.cjs",
			"C:\\repo\\node_modules\\immediate\\lib\\index.js",
			"C:\\repo\\node_modules\\docx\\dist\\index.mjs",
		];
		for (const p of paths) {
			// Fresh test each call: STRIP_FILTER is non-global, but be explicit.
			expect(STRIP_FILTER.test(p), `expected match: ${p}`).toBe(true);
		}
	});

	it("STRIP_FILTER does not match unrelated modules", () => {
		const nonMatches = [
			"/repo/node_modules/immediate/lib/browser.js",
			"/repo/node_modules/lie/lib/index.js",
			"/repo/src/main.ts",
			"/repo/node_modules/docx/dist/other.mjs",
		];
		for (const p of nonMatches) {
			expect(STRIP_FILTER.test(p), `expected no match: ${p}`).toBe(false);
		}
	});

	it("TEST_RE and BODY_RE are declared global (String.replace-all semantics)", () => {
		expect(TEST_RE.flags).toContain("g");
		expect(BODY_RE.flags).toContain("g");
	});
});
