"""本地演示服务器：起一个静态服务并自动打开演示页。

为什么需要它：MediaPipe 的 WASM 模块拒绝在 file:// 下加载（报 Invalid security origin），
必须通过 http://127.0.0.1 访问才属于安全上下文，摄像头也能正常授权。

用法：python serve.py   （或直接双击 start-demo.bat）
"""

import http.server
import os
import socketserver
import sys
import threading
import webbrowser

# 允许端口复用：避免刚关掉服务又立刻重开时报「地址已被占用」
socketserver.TCPServer.allow_reuse_address = True

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
URL = f"http://127.0.0.1:{PORT}/demo/index.html"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass


def open_browser():
    webbrowser.open(URL)


def main():
    try:
        httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"端口 {PORT} 已被占用，可能服务已在运行。直接访问：{URL}")
        webbrowser.open(URL)
        return

    print("=" * 52)
    print(f"  演示地址：{URL}")
    print(f"  根目录：  {ROOT}")
    print("  关闭窗口或按 Ctrl+C 结束")
    print("=" * 52)

    threading.Timer(1.0, open_browser).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
