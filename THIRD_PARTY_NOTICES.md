# 第三方组件和来源

本项目保留第三方文件自身的许可证及版权声明。以下组件不属于企业业务数据。

| 组件 | 用途 | 来源与许可 |
|---|---|---|
| Apache ECharts 5.6.0 | 图表、地图和交互 | Apache-2.0；本地文件 `web/vendor/echarts.min.js`，附带 LICENSE 与 NOTICE |
| marked 14.1.4 | Markdown 渲染 | MIT；`web/vendor/marked.LICENSE.md` |
| DOMPurify 3.2.7 | 清理 Markdown 转换后的 HTML | Apache-2.0 或 MPL-2.0；`web/vendor/dompurify.LICENSE.txt` |
| 中国省市 GeoJSON | 通用行政区划底图 | 原项目通用底图资源；来源为阿里云 DataV 行政区划服务 `https://geo.datav.aliyun.com/areas_v3/bound/`，不是企业客户位置数据 |

模拟业务数据由 `scripts/generate_demo_data.py` 独立生成，不来自第三方数据集或企业数据导出。行政区划图用于产品演示，不能用于导航、测绘或精确边界判定。
