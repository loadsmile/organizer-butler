import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { assertPathInside, isPathInside, UnsafePathError } from "../src/core/security/paths.js";

describe("path containment", () => {
  const root = path.resolve(path.sep, "tmp", "downloads");

  it("accepts the root and descendants", () => {
    assert.equal(isPathInside(root, root), true);
    assert.equal(isPathInside(root, path.join(root, "Finance", "invoice.pdf")), true);
  });

  it("rejects traversal, absolute outsiders, and similarly prefixed directories", () => {
    assert.equal(isPathInside(root, path.join(root, "..", "secret.txt")), false);
    assert.equal(isPathInside(root, path.resolve(path.sep, "etc", "passwd")), false);
    assert.equal(isPathInside(root, `${root}-backup/file.txt`), false);
    assert.throws(() => assertPathInside(root, `${root}-backup/file.txt`), UnsafePathError);
  });
});
