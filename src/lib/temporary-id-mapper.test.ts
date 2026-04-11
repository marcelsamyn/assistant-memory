/* eslint-disable @typescript-eslint/no-unused-vars */
import { TemporaryIdMapper } from "./temporary-id-mapper";
import { describe, it, expect } from "vitest";

describe("TemporaryIdMapper", () => {
  it("maps items to unique temp IDs and preserves mapping", () => {
    type Item = { name: string };
    const items: Item[] = [
      { name: "Alice" },
      { name: "Bob" },
      { name: "Charlie" },
    ];
    const mapper = new TemporaryIdMapper<Item, string>(
      (item, idx) => `temp_${item.name}_${idx}`,
    );
    const mapped = mapper.mapItems(items);
    expect(mapped).toHaveLength(3);
    mapped.forEach((m, idx) => {
      expect(m).toHaveProperty("tempId", `temp_${items[idx]!.name}_${idx}`);
      expect(m.name).toBe(items[idx]!.name);
      const tid = mapper.getId(items[idx]!)!;
      expect(tid).toBe(m.tempId);
      const orig = mapper.getItem(m.tempId)!;
      expect(orig).toBe(items[idx]!);
    });
  });

  it("getId and getItem return undefined for non-existing entries", () => {
    const items = [{ id: 1 }, { id: 2 }];
    const mapper = new TemporaryIdMapper<(typeof items)[0], string>(
      (item, _idx) => `id_${item.id}`,
    );
    expect(mapper.getId(items[0]!)).toBeUndefined();
    expect(mapper.getItem("id_1")).toBeUndefined();

    mapper.mapItems(items);
    expect(mapper.getId(items[0]!)).toBe(`id_${items[0]!.id}`);
    expect(mapper.getItem(`id_${items[1]!.id}`)).toBe(items[1]);
  });

  it("entries returns all {item,id} pairs", () => {
    const values = [10, 20];
    const mapper = new TemporaryIdMapper<number, string>(
      (item, _idx) => `v${item}`,
    );
    mapper.mapItems(values);
    const entries = mapper.entries();
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        { item: values[0], id: `v${values[0]}` },
        { item: values[1], id: `v${values[1]}` },
      ]),
    );
    expect(entries.map((e) => e.id)).toEqual(values.map((i) => `v${i}`));
    expect(entries.map((e) => e.item)).toEqual(values);
  });

  it("throws error when duplicate IDs are generated", () => {
    const items = ["a", "b", "c"];
    const mapper = new TemporaryIdMapper<string, string>(
      (_item, _idx) => "dup",
    );
    expect(() => mapper.mapItems(items)).toThrowError(
      "Duplicate temporary ID generated: dup",
    );
  });

  it("handles empty array without errors", () => {
    const mapper = new TemporaryIdMapper<number, string>(
      (item, _idx) => `n${item}`,
    );
    const mapped = mapper.mapItems([]);
    expect(mapped).toEqual([]);
    expect(mapper.entries()).toEqual([]);
  });

  it("does not mutate original items and returns new objects", () => {
    const items = [{ foo: "bar" }];
    const mapper = new TemporaryIdMapper<(typeof items)[0], string>(
      (_item, _idx) => `id1`,
    );
    const mapped = mapper.mapItems(items);
    expect("tempId" in items[0]!).toBe(false);
    expect(mapped[0]).not.toBe(items[0]);
    expect(mapped[0]!.foo).toBe("bar");
  });

  it("throws on second mapping of same items", () => {
    const items = [1];
    const mapper = new TemporaryIdMapper<number, string>(
      (item, _idx) => `id${item}`,
    );
    mapper.mapItems(items);
    expect(() => mapper.mapItems(items)).toThrow(
      /Duplicate temporary ID generated/,
    );
  });

  it("supports mapping disjoint sets sequentially", () => {
    const items1 = [1, 2];
    const items2 = [3];
    const mapper = new TemporaryIdMapper<number, string>(
      (item, _idx) => `id_${item}`,
    );
    const mapped1 = mapper.mapItems(items1);
    const mapped2 = mapper.mapItems(items2);
    expect(mapped1.map((m) => m.tempId)).toEqual(items1.map((i) => `id_${i}`));
    expect(mapped2.map((m) => m.tempId)).toEqual(items2.map((i) => `id_${i}`));
    expect(mapper.entries()).toHaveLength(3);
    expect(mapper.getItem("id_3")!).toBe(3);
  });

  it("throws error when duplicate IDs are generated across batches", () => {
    const items1 = [1];
    const items2 = [2];
    const mapper = new TemporaryIdMapper<number, string>(
      (_item, _idx) => "dup",
    );
    mapper.mapItems(items1);
    expect(() => mapper.mapItems(items2)).toThrowError(
      "Duplicate temporary ID generated: dup",
    );
  });

  it("maintains insertion order in entries", () => {
    const values = ["x", "y", "z"];
    const mapper = new TemporaryIdMapper<string, string>(
      (item, idx) => `${item}${idx}`,
    );
    mapper.mapItems(values);
    const entries = mapper.entries();
    expect(entries.map((e) => e.id)).toEqual(values.map((v, i) => `${v}${i}`));
    expect(entries.map((e) => e.item)).toEqual(values);
  });

  it("distinguishes object items by identity", () => {
    const o1 = { x: 1 };
    const o2 = { x: 1 };
    const mapper = new TemporaryIdMapper<typeof o1, string>(
      (_, idx) => `t${idx}`,
    );
    const mapped = mapper.mapItems([o1, o2]);
    expect(mapper.getItem(mapped[0]!.tempId)).toBe(o1);
    expect(mapper.getItem(mapped[1]!.tempId)).toBe(o2);
  });
});
