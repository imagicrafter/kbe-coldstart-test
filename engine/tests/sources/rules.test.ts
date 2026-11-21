import { describe, it, expect } from "vitest";
import {
  addressValue,
  firefliesFilter,
  gmailClause,
  gmailLabelTerm,
  gmailQuery,
  parseRules,
  splitAddresses,
  type Rule,
} from "../../src/sources/rules.js";

const inc = (match: Rule["match"], topic = "clients"): Rule => ({ kind: "include", match, topic });
const exc = (match: Rule["match"]): Rule => ({ kind: "exclude", match });

describe("address values", () => {
  it("keeps an address, turns a domain into @domain, refuses anything else", () => {
    expect(addressValue(" Bob@Acme.com ")).toBe("bob@acme.com");
    expect(addressValue("acme.com")).toBe("@acme.com");
    expect(addressValue("@Sales.Acme.com")).toBe("@sales.acme.com");
    expect(addressValue("not an address")).toBeNull();
    expect(addressValue("acme")).toBeNull();
  });

  it("splits typed chips and reports the bad ones", () => {
    expect(splitAddresses("bob@acme.com, acme.org; nope  @x.io")).toEqual({
      values: ["bob@acme.com", "@acme.org", "@x.io"],
      bad: ["nope"],
    });
  });
});

describe("Gmail query", () => {
  it("label terms use the name in Gmail's search form", () => {
    expect(gmailLabelTerm("Clients/Acme Inc")).toBe("label:clients-acme-inc");
  });

  it("a rule's fields are ANDed and its values ORed", () => {
    expect(gmailClause(inc({ from: ["bob@acme.com", "@acme.org"], labels: [{ id: "L1", name: "Deals" }] }))).toBe(
      "((from:bob@acme.com OR from:acme.org) label:deals)",
    );
  });

  it("is the OR of include rules, minus every exclude, after since", () => {
    const q = gmailQuery([exc({ labels: [{ id: "L9", name: "Personal" }] }), inc({ any_address: ["@acme.com"] }), inc({ labels: [{ id: "L2", name: "Board" }] })], 100);
    expect(q).toBe("((from:acme.com OR to:acme.com OR cc:acme.com) OR label:board) -label:personal after:100");
  });

  it("one include alone needs no outer group", () => {
    expect(gmailQuery([inc({ to: ["ann@x.com"] })], 5)).toBe("to:ann@x.com after:5");
  });

  it("is null when no include rule works: nothing to list", () => {
    expect(gmailQuery([], 1)).toBeNull();
    expect(gmailQuery([exc({ from: ["@spam.com"] })], 1)).toBeNull();
    expect(gmailQuery([{ ...inc({ labels: [{ id: "gone" }] }), broken: true }], 1)).toBeNull();
  });
});

describe("Fireflies filter", () => {
  it("collects channels and participants from working include rules only", () => {
    expect(
      firefliesFilter([
        inc({ channels: [{ id: "c1" }] }),
        inc({ participants: ["@acme.com"] }),
        exc({ participants: ["@hr.example"] }),
        { ...inc({ channels: [{ id: "c-gone" }] }), broken: true },
      ]),
    ).toEqual({ channel_ids: ["c1"], participants: ["@acme.com"] });
    expect(firefliesFilter([exc({ channels: [{ id: "c" }] })])).toBeNull();
  });
});

describe("parseRules", () => {
  it("drops malformed rules from the database answer", () => {
    expect(parseRules([{ kind: "include", match: { from: ["a@b.com"] }, topic: "x" }, { kind: "weird" }, "nope"])).toHaveLength(1);
    expect(parseRules(null)).toEqual([]);
  });
});
