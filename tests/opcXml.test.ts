import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  opcAttribute,
  opcNamespacedAttribute,
  OpcXmlError,
  opcRelationshipPartName,
  parseOpcContentTypes,
  parseOpcRelationships,
  parseOpcXml,
  resolveOpcRelationshipTarget,
} from "../src/core/inspector/opcXml.js";

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

function failsWith(failure: OpcXmlError["failure"]): (error: unknown) => boolean {
  return (error) => error instanceof OpcXmlError && error.failure === failure;
}

describe("OPC XML primitives", () => {
  it("decodes UTF-8 XML and reads plain and namespace-aware attributes", () => {
    let plain: string | undefined;
    let namespaced: string | undefined;
    parseOpcXml(Buffer.from('<root plain="value" xmlns:r="urn:relationship" r:id="rId1"/>'), {
      onOpenTag(tag) {
        plain = opcAttribute(tag, "plain");
        namespaced = opcNamespacedAttribute(tag, new Set(["urn:relationship"]), "id");
      },
    });
    assert.equal(plain, "value");
    assert.equal(namespaced, "rId1");
  });

  it("rejects invalid UTF-8, non-UTF-8 declarations, and doctypes", () => {
    assert.throws(() => parseOpcXml(Buffer.from([0xff]), { onOpenTag() {} }), failsWith("malformed"));
    assert.throws(
      () => parseOpcXml(Buffer.from('<?xml version="1.0" encoding="UTF-16"?><root/>'), { onOpenTag() {} }),
      failsWith("unsupported"),
    );
    assert.throws(
      () => parseOpcXml(Buffer.from("<!DOCTYPE root><root/>"), { onOpenTag() {} }),
      failsWith("unsupported"),
    );
  });

  it("parses normalized content-type overrides", () => {
    const contentTypes = parseOpcContentTypes(
      Buffer.from(
        `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="document"/></Types>`,
      ),
    );
    assert.deepEqual([...contentTypes], [["word/document.xml", "document"]]);
  });

  it("rejects duplicate content-type overrides", () => {
    const source = Buffer.from(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="a"/><Override PartName="/word/document.xml" ContentType="b"/></Types>`,
    );
    assert.throws(() => parseOpcContentTypes(source), failsWith("duplicate-part"));
  });

  it("parses relationship envelopes and rejects duplicate IDs and external targets", () => {
    const relationships = parseOpcRelationships(
      Buffer.from(
        `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="type" Target="document.xml"/></Relationships>`,
      ),
    );
    assert.deepEqual(relationships, [{ id: "rId1", type: "type", target: "document.xml" }]);

    const duplicate = Buffer.from(
      `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="a" Target="a.xml"/><Relationship Id="rId1" Type="b" Target="b.xml"/></Relationships>`,
    );
    assert.throws(() => parseOpcRelationships(duplicate), failsWith("malformed"));

    const external = Buffer.from(
      `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}"><Relationship Id="rId1" Type="a" Target="https://example.com" TargetMode="External"/></Relationships>`,
    );
    assert.throws(() => parseOpcRelationships(external), failsWith("unsafe-relationship"));
  });

  it("builds relationship part names for root and nested parts", () => {
    assert.equal(opcRelationshipPartName("document.xml"), "_rels/document.xml.rels");
    assert.equal(opcRelationshipPartName("word/document.xml"), "word/_rels/document.xml.rels");
  });

  it("normalizes safe internal targets and rejects unsafe forms", () => {
    assert.equal(resolveOpcRelationshipTarget("word/document.xml", "media/image.png"), "word/media/image.png");
    for (const target of ["", "/word/document.xml", "../document.xml", "%2e%2e/document.xml", "a\\b.xml", "a.xml?x", "a.xml#x", "https://example.com/a.xml"]) {
      assert.throws(() => resolveOpcRelationshipTarget("word/document.xml", target), failsWith("unsafe-relationship"));
    }
  });
});
