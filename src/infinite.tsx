import { useEffect, useRef, useState } from "react";
import { LoaderCircle, ArrowDown } from "lucide-react";
import { Button } from "./ui";
import type { Data } from "./api";

export function useInfinite(
  load: (from: number, refresh: boolean) => Promise<Data>,
  rowsKey: string,
  nextKey: string,
  idKey: string,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<Data>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const generation = useRef(0),
    busy = useRef(false),
    cursor = useRef<number | null>(0),
    loader = useRef(load),
    force = useRef(false);
  loader.current = load;
  const fetchPage = async (epoch: number, from: number) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await loader.current(from, from === 0 && force.current);
      if (epoch !== generation.current) return;
      const raw = page[nextKey],
        next = raw === undefined || raw === null ? null : Number(raw);
      if (next !== null && (!Number.isFinite(next) || next <= from))
        throw Error("服务器返回了重复的分页游标，请刷新后重试");
      if (!Array.isArray(page[rowsKey])) throw Error("列表响应格式无效");
      cursor.current = next;
      setData((old) => {
        const map = new Map(
          (from === 0 ? [] : old?.[rowsKey] || []).map((v: Data) => [
            v[idKey],
            v,
          ]),
        );
        for (const row of page[rowsKey]) map.set(row[idKey], row);
        return { ...page, [rowsKey]: [...map.values()] };
      });
    } catch (e) {
      if (epoch === generation.current) setError((e as Error).message);
    } finally {
      if (epoch === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    const epoch = ++generation.current;
    busy.current = false;
    cursor.current = 0;
    setData(undefined);
    fetchPage(epoch, 0);
    return () => {
      generation.current++;
    };
  }, [...deps, revision]);
  return {
    data,
    loading,
    error,
    hasMore: cursor.current !== null,
    loadMore: () => {
      if (cursor.current !== null)
        void fetchPage(generation.current, cursor.current);
    },
    reload: () => {
      force.current = true;
      setRevision((v) => v + 1);
    },
  };
}
export function InfiniteEnd({
  list,
  count,
  total,
}: {
  list: ReturnType<typeof useInfinite>;
  count: number;
  total?: number;
}) {
  const sentinel = useRef<HTMLDivElement>(null),
    next = useRef(list.loadMore);
  next.current = list.loadMore;
  useEffect(() => {
    if (!list.hasMore || list.loading || list.error || !sentinel.current)
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) next.current();
      },
      { root: sentinel.current.closest(".modal-body"), rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [list.hasMore, list.loading, list.error, count]);
  return (
    <div ref={sentinel} className="infinite-end">
      <span>
        已加载 {count}
        {total !== undefined ? ` / ${total}` : ""} 项
      </span>
      {list.loading ? (
        <span>
          <LoaderCircle className="spin" size={15} />
          正在加载
        </span>
      ) : list.hasMore ? (
        <Button kind="text" onClick={list.loadMore}>
          <ArrowDown size={14} />
          {list.error ? "重试加载" : "继续加载"}
        </Button>
      ) : (
        <span>已显示全部</span>
      )}
    </div>
  );
}
