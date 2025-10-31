# wheel_remote_test.py
# 依赖：pip install requests websocket-client
import argparse
import json
import time
import threading
import statistics
import uuid
from collections import defaultdict
from datetime import datetime

import requests
try:
    import websocket  # websocket-client
except ImportError:
    websocket = None


class MessageCollector:
    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.spin_acks = defaultdict(list)        # participant -> [ts, ...]
        self.history_times = defaultdict(list)    # participant -> [ts, ...]

    def on_message(self, message: str):
        now = time.time()
        try:
            msg = json.loads(message)
        except Exception:
            return
        t = msg.get("type")
        if t == "spin":
            p = msg.get("payload", {})
            participant = p.get("participant")
            if participant:
                with self.lock:
                    self.spin_acks[participant].append(now)
                    self.cond.notify_all()
        elif t == "history_append":
            p = msg.get("payload", {})
            participant = p.get("participant")
            if participant:
                with self.lock:
                    self.history_times[participant].append(now)
                    self.cond.notify_all()

    def wait_for_ack(self, participant: str, timeout: float):
        end = time.time() + timeout
        with self.lock:
            while time.time() < end:
                if self.spin_acks.get(participant):
                    return self.spin_acks[participant][0]  # first ack
                remaining = end - time.time()
                if remaining > 0:
                    self.cond.wait(timeout=min(remaining, 0.2))
        return None

    def wait_for_history(self, participant: str, count: int, timeout: float):
        end = time.time() + timeout
        with self.lock:
            while time.time() < end:
                lst = self.history_times.get(participant, [])
                if len(lst) >= count:
                    return lst[:count]  # first N results
                remaining = end - time.time()
                if remaining > 0:
                    self.cond.wait(timeout=min(remaining, 0.2))
        return None


class WSObserver:
    def __init__(self, base_ws: str, collector: MessageCollector):
        self.base_ws = base_ws
        self.collector = collector
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if websocket is None:
            print("[WARN] websocket-client 未安装，跳过 WS 观察。执行: pip install websocket-client")
            return
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

    def _run_loop(self):
        # 持续重连直到 stop
        while not self.stop_event.is_set():
            url = f"{self.base_ws}/ws"
            def on_message(ws, message):
                self.collector.on_message(message)

            def on_error(ws, error):
                print(f"[WS ERROR] {error}")

            def on_close(ws, code, reason):
                print(f"[WS CLOSED] code={code} reason={reason}")

            def on_open(ws):
                print("[WS OPENED]")

            ws_app = websocket.WebSocketApp(url,
                                            on_message=on_message,
                                            on_error=on_error,
                                            on_close=on_close,
                                            on_open=on_open)
            try:
                ws_app.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as e:
                print(f"[WS run_forever EXCEPTION] {e}")
            # 断开后稍等重连
            if not self.stop_event.is_set():
                time.sleep(1.0)

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)


def post_spin(base_http: str, participant: str, count: int, timeout: float = 10.0):
    url = f"{base_http}/spin"
    payload = {"participant": participant, "count": count}
    t0 = time.time()
    try:
        resp = requests.post(url, json=payload, timeout=timeout)
        t1 = time.time()
        latency = t1 - t0
        data = None
        try:
            data = resp.json()
        except Exception:
            data = resp.text
        print(f"[{datetime.now().strftime('%H:%M:%S')}] POST {url} -> {resp.status_code} {data}")
        return resp.ok, latency, data
    except requests.RequestException as e:
        t1 = time.time()
        latency = t1 - t0
        print(f"[ERROR] POST {url} failed: {e}")
        return False, latency, None


def percentile(values, p):
    if not values:
        return None
    return statistics.quantiles(values, n=100, method='inclusive')[p-1]


def main():
    parser = argparse.ArgumentParser(description="远程测试转盘：连接WS、触发旋转、验证响应并记录报告")
    parser.add_argument("--host", default="localhost", help="服务器主机/IP")
    parser.add_argument("--port", type=int, default=3000, help="服务器端口（默认3000）")
    parser.add_argument("--tls", action="store_true", help="启用HTTPS/WSS")
    parser.add_argument("--tests", type=int, default=5, help="测试次数（迭代次数）")
    parser.add_argument("--count", type=int, default=1, help="每次触发的旋转次数（最大20）")
    parser.add_argument("--ack-timeout", type=float, default=5.0, help="等待WS spin确认的秒数超时")
    parser.add_argument("--hist-timeout", type=float, default=15.0, help="等待抽奖结果(history_append)的秒数超时")
    parser.add_argument("--interval", type=float, default=1.0, help="每次测试之间的间隔秒数")
    parser.add_argument("--participant", default="远程测试", help="参与者名称前缀（实际会附加唯一后缀）")
    parser.add_argument("--report", default="", help="报告文件路径（可选，写入JSON）")
    args = parser.parse_args()

    scheme = "https" if args.tls else "http"
    wsscheme = "wss" if args.tls else "ws"
    base_http = f"{scheme}://{args.host}:{args.port}"
    base_ws = f"{wsscheme}://{args.host}:{args.port}"

    print(f"[INFO] HTTP: {base_http}  WS: {base_ws}")
    if websocket is None:
        print("[WARN] 未安装 websocket-client，仅进行HTTP触发，无法观察WS推送。建议：pip install websocket-client")

    collector = MessageCollector()
    observer = WSObserver(base_ws, collector)
    observer.start()

    c = max(1, min(20, int(args.count)))
    results = []
    try:
        for i in range(args.tests):
            # 唯一参与者标签，便于匹配WS响应
            tag = f"{args.participant}-{uuid.uuid4().hex[:8]}"
            print(f"[INFO] Test {i+1}/{args.tests} participant={tag} count={c}")

            t0 = time.time()
            ok, http_lat, http_data = post_spin(base_http, tag, c)
            ack_ts = None
            hist_ts_list = None
            ack_latency = None
            first_hist_latency = None
            last_hist_latency = None

            if ok:
                ack_ts = collector.wait_for_ack(tag, args.ack_timeout)
                if ack_ts is not None:
                    ack_latency = ack_ts - t0
                hist_ts_list = collector.wait_for_history(tag, c, args.hist_timeout)
                if hist_ts_list:
                    first_hist_latency = hist_ts_list[0] - t0
                    last_hist_latency = hist_ts_list[-1] - t0

            success = ok and (hist_ts_list is not None and len(hist_ts_list) >= c)
            results.append({
                "test_index": i + 1,
                "participant": tag,
                "count": c,
                "http_ok": ok,
                "http_latency_ms": round(http_lat * 1000, 2) if http_lat is not None else None,
                "ack_latency_ms": round(ack_latency * 1000, 2) if ack_latency is not None else None,
                "first_history_latency_ms": round(first_hist_latency * 1000, 2) if first_hist_latency is not None else None,
                "last_history_latency_ms": round(last_hist_latency * 1000, 2) if last_hist_latency is not None else None,
                "history_received": len(hist_ts_list) if hist_ts_list else 0,
                "success": bool(success),
                "http_data": http_data,
                "timestamp": datetime.now().isoformat(timespec='seconds'),
            })

            print(f"[RESULT] success={success} http={ok} "
                  f"http_lat={round(http_lat*1000,2) if http_lat else None}ms "
                  f"ack_lat={round(ack_latency*1000,2) if ack_latency else None}ms "
                  f"first_hist_lat={round(first_hist_latency*1000,2) if first_hist_latency else None}ms "
                  f"last_hist_lat={round(last_hist_latency*1000,2) if last_hist_latency else None}ms "
                  f"recv={len(hist_ts_list) if hist_ts_list else 0}/{c}")

            if i < args.tests - 1:
                time.sleep(args.interval)
    finally:
        observer.stop()

    # 汇总报告
    success_count = sum(1 for r in results if r["success"])
    failure_count = len(results) - success_count
    http_lats = [r["http_latency_ms"] for r in results if r["http_latency_ms"] is not None]
    ack_lats = [r["ack_latency_ms"] for r in results if r["ack_latency_ms"] is not None]
    first_hist_lats = [r["first_history_latency_ms"] for r in results if r["first_history_latency_ms"] is not None]
    last_hist_lats = [r["last_history_latency_ms"] for r in results if r["last_history_latency_ms"] is not None]

    def stats(name, arr):
        if not arr:
            return f"{name}: 无数据"
        return (f"{name}: count={len(arr)} avg={round(statistics.mean(arr),2)}ms "
                f"min={round(min(arr),2)}ms max={round(max(arr),2)}ms "
                f"p50={round(statistics.median(arr),2)}ms "
                f"p95={round(percentile(arr,95),2) if percentile(arr,95) else None}ms")

    print("\n=== 测试报告 ===")
    print(f"- 成功次数: {success_count}")
    print(f"- 失败次数: {failure_count}")
    print(f"- {stats('HTTP响应耗时', http_lats)}")
    print(f"- {stats('WS确认耗时', ack_lats)}")
    print(f"- {stats('首次结果耗时', first_hist_lats)}")
    print(f"- {stats('全部结果最后一条耗时', last_hist_lats)}")

    if args.report:
        report = {
            "summary": {
                "success": success_count,
                "failure": failure_count,
                "http_stats_ms": {"avg": statistics.mean(http_lats) if http_lats else None,
                                  "min": min(http_lats) if http_lats else None,
                                  "max": max(http_lats) if http_lats else None,
                                  "p50": statistics.median(http_lats) if http_lats else None,
                                  "p95": percentile(http_lats, 95) if http_lats else None},
                "ack_stats_ms": {"avg": statistics.mean(ack_lats) if ack_lats else None,
                                 "min": min(ack_lats) if ack_lats else None,
                                 "max": max(ack_lats) if ack_lats else None,
                                 "p50": statistics.median(ack_lats) if ack_lats else None,
                                 "p95": percentile(ack_lats, 95) if ack_lats else None},
                "first_history_stats_ms": {"avg": statistics.mean(first_hist_lats) if first_hist_lats else None,
                                           "min": min(first_hist_lats) if first_hist_lats else None,
                                           "max": max(first_hist_lats) if first_hist_lats else None,
                                           "p50": statistics.median(first_hist_lats) if first_hist_lats else None,
                                           "p95": percentile(first_hist_lats, 95) if first_hist_lats else None},
                "last_history_stats_ms": {"avg": statistics.mean(last_hist_lats) if last_hist_lats else None,
                                          "min": min(last_hist_lats) if last_hist_lats else None,
                                          "max": max(last_hist_lats) if last_hist_lats else None,
                                          "p50": statistics.median(last_hist_lats) if last_hist_lats else None,
                                          "p95": percentile(last_hist_lats, 95) if last_hist_lats else None},
            },
            "details": results,
            "generated_at": datetime.now().isoformat(timespec='seconds')
        }
        try:
            with open(args.report, "w", encoding="utf-8") as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
            print(f"[INFO] 报告已写入: {args.report}")
        except Exception as e:
            print(f"[ERROR] 写入报告失败: {e}")


if __name__ == "__main__":
    main()