# 复现范围与命令

本目录保存研究证据和合成探针，不是生产采集器。探针只使用合成数据，不需要 X 登录，不应加载生产环境文件。报告中的 `fetched` 是预设内存响应消费数量，不等于所有 HTTP/get 调用次数；空队列会返回 None，详见分页审查。

## 源码和 Python 环境

本次保留的临时位置：

- main 源码：`/tmp/twscrape-research-20261023`，SHA `63f61a518e576ea5c132f1156c03dda0520d76c1`。
- v0.20.1 源码导出：`/tmp/twscrape-repro-v0201`，SHA `5271cbdc5da1095b765a2a7ec750b4ac686d581f`。
- Python 3.13.5 虚拟环境：`/tmp/twscrape-research-venv-20261023`。
- 实际安装依赖：[research-requirements.txt](evidence/research-requirements.txt)。依赖通过 binary wheels 安装；twscrape 从固定源码导入，没有构建/安装上游项目。

如果临时目录已清理，可从公开仓库重新取得两个固定提交，创建独立 Python 3.13.5 环境，再按清单安装依赖。清单记录版本，未保存完整 wheel 集及所有哈希，不能把它当生产供应链锁文件；源仓库自身的 uv.lock 与本次临时环境也存在部分版本差异。未来正式适配应另生成含哈希的锁文件。

所有下列命令要求 Linux 的网络命名空间能力。curl 探针另需 `ip`、OpenSSL 和 loopback。命令中的输出写到新的临时目录，不覆盖已归档证据；未提供真实 X 请求命令。

## 分页、模型与认证探针

以下从本报告目录执行。先设置复现路径：

```sh
cd /www/tweet-watcher-v2/research/twscrape-20261023
TWS_RESEARCH_PY=/tmp/twscrape-research-venv-20261023/bin/python
TWS_RESEARCH_MAIN=/tmp/twscrape-research-20261023
TWS_RESEARCH_TAG=/tmp/twscrape-repro-v0201
TWS_RESEARCH_OUTPUT=$(mktemp -d /tmp/twscrape-recheck.XXXXXX)
export TWS_TELEMETRY=0 DO_NOT_TRACK=1 PYTHONDONTWRITEBYTECODE=1
```

正式版/main 对照及行为断言：

```sh
unshare --net "$TWS_RESEARCH_PY" probes/pagination.py "$TWS_RESEARCH_MAIN" > "$TWS_RESEARCH_OUTPUT/main.json"
unshare --net "$TWS_RESEARCH_PY" probes/assert-pagination.py "$TWS_RESEARCH_OUTPUT/main.json" head
unshare --net "$TWS_RESEARCH_PY" probes/pagination.py "$TWS_RESEARCH_TAG" > "$TWS_RESEARCH_OUTPUT/tag.json"
unshare --net "$TWS_RESEARCH_PY" probes/assert-pagination.py "$TWS_RESEARCH_OUTPUT/tag.json" tag
```

每版预期输出 28 场景、28 项断言通过。这些断言确认问题或行为的可重复性，不代表修复。

HTTPX、数据库、诊断、日志和遥测字段：

```sh
unshare --net env TWS_HTTP_BACKEND=httpx PYTHONPATH="$TWS_RESEARCH_MAIN" "$TWS_RESEARCH_PY" probes/auth-security.py > "$TWS_RESEARCH_OUTPUT/auth.json"
```

curl 实际 HTTP/HTTPS 传输；命名空间内只启用 loopback：

```sh
unshare --net /bin/bash -c 'ip link set lo up && exec env PYTHONPATH="$1" "$2" "$3"' probe "$TWS_RESEARCH_MAIN" "$TWS_RESEARCH_PY" "$PWD/probes/curl-security.py" > "$TWS_RESEARCH_OUTPUT/curl.json"
```

认证和 curl 探针输出布尔观察与非敏感元数据，可和归档 JSON 对照；它们不验证真实账号，也未设置完整自动回归断言。临时合成数据库、dump 和测试 TLS 证书由脚本清理。curl 探针的 HTTPS 信任仅配置给本次测试客户端，未关闭证书验证、未变更系统 CA。

## 上游测试

原始运行在固定 main 源码目录，以 `unshare --net` 禁网络并降为 `nobody` 用户。临时输出目录预先设为该用户可写；命令如下，日志已归档，不必为查看报告重新运行：

```sh
cd /tmp/twscrape-research-20261023
unshare --net runuser -u nobody -- env TWS_TELEMETRY=0 PYTHONDONTWRITEBYTECODE=1 \
  COVERAGE_FILE=/tmp/twscrape-research-test-output/coverage \
  /tmp/twscrape-research-venv-20261023/bin/python -m pytest -q \
  -o cache_dir=/tmp/twscrape-research-test-output/cache \
  --basetemp=/tmp/twscrape-research-test-output/temp \
  --cov=twscrape --cov-report=term-missing
```

结果为 276 passed、82% 行覆盖率。上游 `make update` 会更新 GraphQL/在线样本，**不属于这套离线复现**。

## 其他证据的边界

- 历史 Node 解析器对照调用第一代的 [lib/bird-timeline.mjs](https://github.com/xxvcc/Tweet-Watcher/blob/v3.5.0/lib/bird-timeline.mjs) 的 `parseTimelinePage`，输入固定上游快照 `tests/mocked-data/` 下四份 JSON，记录接受条数或拒绝原因。该对照不依赖 v2 当前代码；如需复现，请在独立第一代检出目录执行，不能以 v2 当前解析器冒充历史结果。没有通过该模块发出网络请求。
- OSV 文件是对研究环境已安装 29 个 Python 包版本的批量查询摘要；不是原始漏洞库快照。查询结果会随漏洞库变化，未完整覆盖 wheel 捆绑原生组件。
- JSON 结果与日志为原始观察或汇总；SHA256 清单可检测后续文件变化，不代表来源签名或安全认证。
