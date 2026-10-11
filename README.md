# 指投 · Index Quota

一个可以直接部署到 **GitHub Pages** 的纳斯达克、标普500基金额度看板。原生 HTML/CSS/JavaScript 前端，Python 标准库采集，无前端依赖、无需 API Key 或常驻服务器。

## 已实现

- 扫描完整公开基金目录，自动发现名称包含“纳斯达克”“纳指”“标普500”的基金，按公司与份额收录。
- 纳斯达克100 / 标普500 / 其他相关分类；公司、代码、名称、币种、A/C 等份额、交易方式和交易状态筛选。
- 分开展示日累计申购限额、定投支持状态、定投起点、单独披露的定投上限。
- 原始字段、抓取时间、基金档案及公告入口。
- 星标关注（保存在当前浏览器）、额度变动记录、导出筛选结果 CSV。
- 每 4 小时计划采集；页面每 5 分钟检查快照，也可手动刷新。
- 失败时保留旧数据、本地缓存回退、超过 12 小时的记录标记待更新。
- 手机自适应布局；宽表格可横向滚动；键盘 `/` 聚焦搜索，`Esc` 关闭详情。

2026-10-08 首次实际采集：**20 家基金公司、113 个基金份额，113 个成功抓取**。份额数量不是独立基金产品数量。这只是当时公开目录的规则匹配结果，不是保证无遗漏的行业全量名单。

## 数据口径：务必先看

**日累计申购限额 ≠ 定投起点 ≠ 单独定投上限。**

当前已验证可稳定获取的数据来自 **天天基金公开交易规则页**，不是所有销售渠道通用的交易承诺。支付宝、银行、券商和基金公司直销可能存在不同限制。

当前来源通常没有单独披露定投上限，所以网站会显示“未披露 / 需查公告核验”，不会把申购限额偷换成定投上限。该版本尚未自动解析各公司公告中的定投上限、合并份额规则、限额生效时间，也没有接入支付宝或直销实时限额接口。详情中的公告入口是天天基金收录的公告，供人工核验。

- “支持定投”描述该渠道页面显示的状态；扣款是否成功仍以交易系统为准。
- “未代销”只代表天天基金未代销该份额，不能推断其他渠道。
- 暂停申购时仍可能显示历史限额，这不代表当前可以买入。
- A/C 等份额的额度可能合并计算，不应相加。
- 美元份额的页面若仅写“元”，保留原文并标记币种未核验，不参与跨币种排序。
- 场内 ETF 的证券交易、一级市场申赎与券商定投不同，场外定投字段标为不适用。
- 默认“核心指数”只包括纳斯达克100、标普500。纳斯达克科技、生物科技、主动精选和标普500等权产品另列“其他相关”；不包含其他标普行业或红利指数基金。
- 抓取时间不等于公告发布时间或规则生效时间。来源可能滞后、改版或限制抓取。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个空仓库，例如 `index-quota`。公开仓库可使用免费 GitHub Pages；私有仓库需相应套餐。
2. 将本目录的**全部内容**提交到仓库根目录，确保 `index.html` 与 `.github/workflows/pages.yml` 存在，**不要漏掉隐藏目录 `.github`**。
3. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
4. 仓库 **Settings → Actions → General → Workflow permissions** 允许工作流写入仓库（Read and write permissions），保存。若组织策略或受保护分支禁止机器人推送，需要由仓库管理员调整相应规则。
5. 打开 **Actions → Refresh data and deploy Pages → Run workflow**，首次手动运行会抓取最新数据并部署。
6. 等待工作流的 `deploy` 成功，在 Settings → Pages 查看地址，通常是 `https://你的用户名.github.io/index-quota/`。

如果本机已配置 Git/GitHub，可以在本目录执行（将地址换成你的真实仓库）：

```bash
git init
git add .
git commit -m "Initial index quota dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/index-quota.git
git push -u origin main
```

工作流默认监听 `main` / `master`。若使用其他默认分支，请修改工作流里的 `branches`。所有网页资源均使用相对路径，可直接部署到项目子路径，无需设置 Vite base 或修改域名。

## 更新机制

```text
GitHub Actions（计划每4小时 / 手动运行）
    ↓
扫描天天基金目录 → 每份额抓取交易规则与基金档案
    ↓
字段校验 → 与旧快照比较 → 保留有效数据及近90天变动
    ↓
提交 data/*.json → 构建 _site → 发布 GitHub Pages
    ↓
浏览器刷新 / 每5分钟轮询，读取最新发布快照
```

**网页的刷新按钮只读取已发布快照，不会立即运行 GitHub Actions 或请求上游数据。** 如需立刻重新采集，在仓库 Actions 页面手动运行工作流。网页不保存 GitHub Token。

定时计划为 UTC 每 4 小时的第 17 分钟，对应北京时间 **00:17、04:17、08:17、12:17、16:17、20:17**。这是计划而非准点保证，GitHub 可能排队、延迟或丢弃任务；公开仓库长期无活动（通常 60 天）可能停用定时任务，请查看 Actions 状态。Fork 后也需要手动启用工作流。

提高频率：修改 `.github/workflows/pages.yml` 的 cron，并同步 `scripts/update_data.py` 的 `schedule_hours` 和前端说明。不要使用过密的抓取频率；默认最多 4 个并发请求，失败重试 3 次，超时 25 秒。

质量保护：目录少于 1,000 条、匹配少于 30 份、匹配数量相比旧快照骤降超过 15%、抓取成功率低于 80% 时，本轮拒绝覆盖 `funds.json`，仅写入 `health.json` 报告错误。单份额失败保留旧数据并标记；目录消失的旧份额保留并标记待核验。新基金首次收录不制造变动事件。

采集失败时工作流仍发布旧快照与错误提示，Actions 日志显示 warning；查看站内数据状态或 `data/health.json` 可发现问题。工作流自身的权限、部署失败则显示为失败。

## 本地预览与校验

运行环境：Python 3.9+；逻辑测试需要 Node.js 20+。不需要 `pip install` 或 `npm install`。

```bash
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

不要直接双击 `index.html` 使用 `file://`，浏览器会阻止 fetch/ES Module。代码和数据都已附带，本地预览本身不需要联网。

```bash
python3 scripts/update_data.py    # 联网更新公开数据
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/core.test.js
python3 scripts/build_site.py    # 生成只含公开网页资产的 _site/
```

可临时写入另一个数据目录：

```bash
python3 scripts/update_data.py --data-dir /tmp/index-quota-data --workers 3
```

## 文件结构

```text
index.html                 页面结构
assets/style.css           响应式样式
assets/app.js              交互、缓存、刷新、详情
assets/core.js             筛选、金额格式、导出、数据校验
data/funds.json            当前有效快照（附真实初始数据）
data/changes.json          历史变动（首次为空属正常）
data/health.json           最近采集结果
scripts/update_data.py     数据采集与质量保护
scripts/build_site.py      Pages 静态产物构建
tests/                    采集解析与前端逻辑回归测试
.github/workflows/pages.yml 定时采集、提交与部署
```

无广告、无分析埋点、无账号系统。关注和离线快照只保存在使用者的浏览器。代码采用 MIT 许可；第三方数据的权利归其来源，使用和再分发须遵守来源要求。
