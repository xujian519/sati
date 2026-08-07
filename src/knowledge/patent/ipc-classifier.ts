import type { IpcClassification } from "./types.js";
export type { IpcClassification } from "./types.js";

/**
 * IPC 分类器（移植自 Mady domains/ipc/）。
 *
 * 两级关键词规则匹配：先按部（A-H）关键词表扫描文本，对命中部再按高频
 * 大类关键词子表（IPC_DETAIL_DOMAINS）做二次匹配，产出 detail（如 "A61"）。
 * 置信度 = 0.5 + 0.5*(1 - e^(-命中数/K))，只依赖绝对命中数，不受关键词表
 * 长度影响（消除"关键词少的部虚高"）；无匹配时返回默认 B（作业/运输）
 * 和低置信度 0.15。
 */

const MIN_CONFIDENCE_FOR_KEYWORD = 0.5;
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;
/** 置信度饱和函数参数 K（命中 K 词时达到 (1-1/e) ≈ 0.632 的归一化增量）。 */
const CONFIDENCE_SATURATION_K = 3;
/** 大类精注入置信度门槛：detailConfidence >= 该值（≈ 大类命中 ≥2 词）才精注入，否则回退部级。 */
export const IPC_DETAIL_MIN_CONFIDENCE = 0.7;
/** 多重分类门槛：confidence >= 该值（与部级命中 ≥2 词等价：2 词=0.743，1 词=0.642）的部参与并行注入。 */
export const MULTI_CLASSIFY_MIN_CONFIDENCE = 0.7;

export type IpcDomainMeta = {
  section: string;
  name: string;
  keywords: string[];
  inventivenessFocus: string[];
  commonKnowledge: string[];
};

/** A-H 八个部的关键词与审查要点（对齐 Mady AllDomains）。 */
export const IPC_DOMAINS: IpcDomainMeta[] = [
  {
    section: "A",
    name: "人类生活必需",
    keywords: [
      "医药",
      "药物",
      "药品",
      "医疗",
      "治疗",
      "诊断",
      "手术",
      "食品",
      "饮料",
      "调味",
      "发酵",
      "微生物",
      "酶",
      "农业",
      "农药",
      "肥料",
      "种植",
      "养殖",
      "畜牧",
      "化妆品",
      "洗涤",
      "口腔护理",
      "烟草",
      "吸烟",
      "过滤嘴",
      "家具",
      "床",
      "椅",
      "桌",
      "厨房",
      "烹饪",
      "体育",
      "运动",
      "玩具",
      "游戏",
    ],
    inventivenessFocus: [
      "预料不到的技术效果是创造性判断的核心考量",
      "化学/医药领域强调实验数据的充分公开和对比",
      "生物活性效果需提供定量实验证据（IC50/EC50等）",
      "结构类似化合物的创造性需考虑构效关系",
      "已知产品的新的医疗用途可能具有创造性（第二医药用途）",
      "食品领域的创造性常体现在配方组合和工艺改进",
      "农业领域的组合物发明需证明协同效应",
    ],
    commonKnowledge: [
      "常规的药物制剂技术（片剂/胶囊/注射剂）",
      "常见的食品加工方法（干燥/冷冻/杀菌）",
      "基础的农用肥料配方",
      "常规的家居产品设计（桌/椅/床的基本结构）",
    ],
  },
  {
    section: "B",
    name: "作业/运输",
    keywords: [
      "运输",
      "车辆",
      "汽车",
      "自行车",
      "船舶",
      "飞行器",
      "分离",
      "过滤",
      "离心",
      "蒸馏",
      "萃取",
      "混合",
      "搅拌",
      "乳化",
      "粉碎",
      "成型",
      "铸造",
      "锻造",
      "冲压",
      "焊接",
      "印刷",
      "打印",
      "复印",
      "装订",
      "包装",
      "容器",
      "瓶子",
      "罐",
      "封口",
      "输送",
      "传送",
      "搬运",
      "机械手",
      "机器人",
      "涂覆",
      "喷涂",
      "涂布",
    ],
    inventivenessFocus: [
      "机械结构的改进是创造性判断的常见类型",
      "结构简化/功能集成常被认定为具有创造性",
      "参数优化（速度/精度/能耗）需证明非显而易见",
      "运输领域的创造性常体现在技术效果的协同性",
      "自动化/智能化改进通常具有创造性",
      "已知结构的新的应用场景可能具有创造性",
    ],
    commonKnowledge: [
      "常规的机械连接方式（螺栓/焊接/卡扣）",
      "常见的传动机构（齿轮/皮带/链条）",
      "基本的过滤和分离原理",
      "常规的输送装置设计",
    ],
  },
  {
    section: "C",
    name: "化学/冶金",
    keywords: [
      "化学",
      "化合物",
      "组合物",
      "聚合物",
      "共聚物",
      "催化",
      "催化剂",
      "反应",
      "合成",
      "合金",
      "金属",
      "钢铁",
      "有色金属",
      "玻璃",
      "陶瓷",
      "水泥",
      "耐火",
      "燃料",
      "石油",
      "润滑油",
      "沥青",
      "涂料",
      "颜料",
      "染料",
      "油墨",
      "电镀",
      "电解",
      "腐蚀",
      "防护",
      "高分子",
      "树脂",
      "塑料",
      "橡胶",
      "纤维",
    ],
    inventivenessFocus: [
      "预料不到的技术效果是化学领域创造性的核心判断标准",
      "化合物的创造性需对比最接近的已知化合物",
      "组合物发明的创造性需证明组分之间的协同效应",
      "选择性发明（从已知范围中选定具体化合物）需证明预料不到的效果",
      "已知产品的新性能/新用途可能具有创造性",
      "工艺参数的优化需证明非显而易见的技术效果",
      "化学领域允许补充实验数据证明创造性",
      "Markush 通式范围的概括需有代表性实施例支持",
    ],
    commonKnowledge: [
      "常规的有机化学反应（酯化/酰化/还原等）",
      "常见的高分子聚合方法（本体/溶液/乳液/悬浮）",
      "常规的金属热处理工艺（退火/淬火/回火）",
      "基本的分析测试方法（IR/NMR/HPLC/MS）",
    ],
  },
  {
    section: "D",
    name: "纺织/造纸",
    keywords: [
      "纺织",
      "织物",
      "针织",
      "编织",
      "无纺布",
      "纤维",
      "纱线",
      "丝线",
      "染色",
      "印花",
      "整理",
      "柔软",
      "造纸",
      "纸浆",
      "纸张",
      "纸板",
      "制革",
      "皮革",
      "鞣制",
    ],
    inventivenessFocus: [
      "纺织工艺参数的优化通常需要证明非显而易见的效果",
      "功能性面料（防水/抗菌/阻燃等）的创造性在于技术效果的平衡",
      "纤维成分的组合比例可能具有创造性",
      "染整工艺的创新常体现在环保和节能效果",
      "造纸工艺的创造性常体现在纸浆配比和工艺条件",
    ],
    commonKnowledge: ["常规的纺织工艺（纺纱/织造/针织）", "常见的染色方法（浸染/轧染/印花）", "基本的纸张抄造工艺"],
  },
  {
    section: "E",
    name: "固定建筑物",
    keywords: [
      "建筑",
      "房屋",
      "结构",
      "框架",
      "道路",
      "桥梁",
      "隧道",
      "涵洞",
      "水利",
      "大坝",
      "堤坝",
      "防洪",
      "采矿",
      "矿井",
      "采掘",
      "地基",
      "桩基",
      "基础",
      "支护",
      "管道",
      "给水",
      "排水",
      "暖通",
      "门",
      "窗",
      "屋顶",
      "楼板",
      "墙体",
    ],
    inventivenessFocus: [
      "建筑结构的创新常体现在受力性能的改善",
      "施工方法的创造性在于效率和安全性的提升",
      "抗震/抗风等性能改进通常具有创造性",
      "新材料在建筑中的应用可能具有创造性",
      "绿色建筑技术的创造性常体现在节能环保效果",
    ],
    commonKnowledge: [
      "常规的建筑结构形式（框架/剪力墙/筒体）",
      "常见的施工方法（现浇/预制/钢结构安装）",
      "基本的地基处理方式",
      "常规的管道布置和连接方式",
    ],
  },
  {
    section: "F",
    name: "机械工程",
    keywords: [
      "发动机",
      "内燃机",
      "涡轮",
      "燃气轮机",
      "泵",
      "压缩机",
      "风机",
      "阀门",
      "轴承",
      "齿轮",
      "传动",
      "联轴器",
      "热交换",
      "换热器",
      "锅炉",
      "蒸汽",
      "制冷",
      "空调",
      "冷冻",
      "照明",
      "灯具",
      "光源",
      "武器",
      "弹药",
      "蒸汽机",
      "气动",
      "液压",
    ],
    inventivenessFocus: [
      "机械结构的改进是创造性判断的常见类型",
      "效率提升和能耗降低常用于支持创造性",
      "模块化/集成化设计通常具有创造性",
      "参数范围的优化选择需证明非显而易见的效果",
      "控制方法与机械结构的结合可能具有创造性",
    ],
    commonKnowledge: [
      "常规的热力学循环（Rankine/Brayton/制冷循环）",
      "常见的机械密封方式",
      "基本的流体机械原理（离心/轴流/容积式）",
      "常规的润滑和冷却方式",
    ],
  },
  {
    section: "G",
    name: "物理",
    keywords: [
      "测量",
      "检测",
      "传感器",
      "计量",
      "仪器",
      "光学",
      "透镜",
      "显微镜",
      "望远镜",
      "光纤",
      "控制",
      "调节",
      "自动控制",
      "反馈",
      "计算",
      "数据处理",
      "算法",
      "图像处理",
      "显示",
      "显示器",
      "屏幕",
      "投影",
      "信号",
      "信号处理",
      "滤波",
      "导航",
      "定位",
      "GPS",
      "声学",
      "音响",
      "扬声器",
      "麦克风",
      "核物理",
      "核能",
      "辐射",
    ],
    inventivenessFocus: [
      "测量方法的创造性体现在精度/速度/范围的提升",
      "控制方法的改进常与特定技术领域结合判断",
      "信号处理算法的创造性需结合技术效果",
      "光学系统的改进需证明非显而易见的技术效果",
      "计算机实施的发明的创造性判断需整体考虑技术贡献",
      "参数选择（分辨率/灵敏度/带宽等）需证明预料不到的效果",
    ],
    commonKnowledge: [
      "常规的测量原理（电阻/电容/电感/光电/超声）",
      "基本的信号处理方法（滤波/放大/模数转换）",
      "常见的光学系统设计（成像/照明/干涉）",
      "基础的控制理论（PID/反馈/前馈）",
    ],
  },
  {
    section: "H",
    name: "电学",
    keywords: [
      "电路",
      "集成电路",
      "芯片",
      "半导体",
      "通信",
      "无线",
      "移动通信",
      "网络",
      "协议",
      "发电",
      "输电",
      "配电",
      "电力系统",
      "电池",
      "蓄电池",
      "燃料电池",
      "太阳能",
      "电机",
      "电动机",
      "发电机",
      "变压器",
      "电子",
      "电子设备",
      "放大器",
      "振荡器",
      "天线",
      "雷达",
      "射频",
      "数字",
      "编码",
      "解码",
      "调制",
      "解调",
      "LED",
      "激光",
      "光电",
    ],
    inventivenessFocus: [
      "电路结构的简化/集成通常具有创造性",
      "通信协议和信号处理方法的改进需结合技术效果判断",
      "电力系统控制的创造性体现在效率/稳定性/安全性提升",
      "半导体器件的结构改进需要证明非显而易见的电学性能",
      "电池技术的创造性常体现在能量密度/循环寿命的改善",
      "通信领域的标准必要专利的创造性判断具有特殊性",
    ],
    commonKnowledge: [
      "常规的电路拓扑（整流/放大/滤波/振荡）",
      "常见的通信调制方式（AM/FM/QPSK/QAM/OFDM）",
      "基本的电力系统知识（发电/输电/变电/配电）",
      "常规的半导体器件结构（MOSFET/BJT/二极管）",
    ],
  },
];

/** 无匹配时的默认分类（与 Mady 一致：B 部，置信度 0.15）。 */
export const DEFAULT_IPC_SECTION = "B";
export const DEFAULT_IPC_CONFIDENCE = 0.15;

/** 高频大类的关键词子表（两级分类第二级；对齐 ipc-standards.yaml 的 ipcDetail）。 */
export type IpcDetailDomainMeta = {
  /** IPC 大类号，如 "A61" */
  detail: string;
  /** 所属部（A-H），与 IPC_DOMAINS 的 section 对应 */
  section: string;
  /** 大类名称 */
  name: string;
  /** 大类关键词（技术领域词；未列入的大类回退部级注入） */
  keywords: string[];
};

/** 高频大类关键词表（10 个：卡片数最多的医药/食品/车辆/包装/有机化学/测量/计算/电气元件/电力/通信）。 */
export const IPC_DETAIL_DOMAINS: IpcDetailDomainMeta[] = [
  {
    detail: "A61",
    section: "A",
    name: "医药/医疗器械",
    keywords: [
      "医药",
      "药物",
      "药品",
      "药剂",
      "给药",
      "剂型",
      "片剂",
      "胶囊",
      "注射液",
      "输液",
      "医疗器械",
      "手术器械",
      "植入",
      "假体",
      "支架",
      "诊断设备",
      "医用",
      "生物相容",
    ],
  },
  {
    detail: "A23",
    section: "A",
    name: "食品",
    keywords: [
      "食品",
      "乳制品",
      "饮料",
      "调味",
      "烘焙",
      "保鲜",
      "冷藏",
      "谷物",
      "面粉",
      "茶",
      "咖啡",
      "酒",
      "酿造",
      "膳食",
      "营养",
      "休闲食品",
      "加工食品",
    ],
  },
  {
    detail: "B60",
    section: "B",
    name: "车辆",
    keywords: [
      "车辆",
      "汽车",
      "车架",
      "车身",
      "车轴",
      "车轮",
      "轮胎",
      "制动",
      "刹车",
      "转向",
      "悬架",
      "座椅",
      "安全带",
      "气囊",
      "驾驶室",
      "客车",
      "货车",
      "挂车",
      "摩托车",
      "车灯",
    ],
  },
  {
    detail: "B65",
    section: "B",
    name: "输送包装",
    keywords: [
      "包装",
      "容器",
      "封口",
      "密封",
      "包装机",
      "输送",
      "传送",
      "传送带",
      "分拣",
      "码垛",
      "贴标",
      "捆扎",
      "打包",
      "托盘",
      "箱子",
      "瓶子",
      "罐",
      "标签",
    ],
  },
  {
    detail: "C07",
    section: "C",
    name: "有机化学",
    keywords: [
      "有机化合物",
      "杂环",
      "芳香族",
      "烷基",
      "烯",
      "炔",
      "醇",
      "酚",
      "醛",
      "酮",
      "羧酸",
      "酯",
      "胺",
      "酰胺",
      "氨基酸",
      "核苷",
      "糖苷",
      "中间体",
      "手性",
      "异构体",
      "聚合",
      "高分子",
    ],
  },
  {
    detail: "G01",
    section: "G",
    name: "测量测试",
    keywords: [
      "测量",
      "计量",
      "校准",
      "仪表",
      "探头",
      "示波器",
      "频谱",
      "流量计",
      "压力测量",
      "温度测量",
      "位移测量",
      "角度测量",
      "检测仪器",
      "测试装置",
    ],
  },
  {
    detail: "G06",
    section: "G",
    name: "计算",
    keywords: [
      "计算",
      "数据处理",
      "算法",
      "图像处理",
      "图像识别",
      "模式识别",
      "机器学习",
      "人工智能",
      "神经网络",
      "深度学习",
      "计算机",
      "处理器",
      "存储器",
      "数据库",
      "人机交互",
      "语音识别",
      "自然语言",
    ],
  },
  {
    detail: "H01",
    section: "H",
    name: "基本电气元件",
    keywords: [
      "集成电路",
      "芯片",
      "半导体",
      "晶体管",
      "二极管",
      "电容器",
      "电阻器",
      "电感",
      "继电器",
      "连接器",
      "印刷电路",
      "封装",
      "晶圆",
      "衬底",
      "LED",
      "发光二极管",
      "太阳能电池",
      "光伏",
      "激光器",
    ],
  },
  {
    detail: "H02",
    section: "H",
    name: "发电变电配电",
    keywords: [
      "发电",
      "输电",
      "配电",
      "变电",
      "电力系统",
      "变压器",
      "整流器",
      "逆变器",
      "蓄电池",
      "电池",
      "燃料电池",
      "充电",
      "充电桩",
      "电动机",
      "发电机",
      "电网",
      "稳压",
      "电压调节",
    ],
  },
  {
    detail: "H04",
    section: "H",
    name: "电子通信",
    keywords: [
      "通信",
      "无线",
      "移动通信",
      "基站",
      "天线",
      "射频",
      "调制",
      "解调",
      "编码",
      "解码",
      "信道",
      "载波",
      "信号传输",
      "网络",
      "蓝牙",
      "WIFI",
      "数据传输",
      "广播",
      "电话",
      "卫星通信",
    ],
  },
];

/** 返回所有 IPC 大类的关键词匹配结果（含未命中部按置信度排序；命中部附两级 detail）。 */
export function classifyIpc(text: string): IpcClassification[] {
  const results: IpcClassification[] = [];
  const lowered = text.toLowerCase();

  for (const domain of IPC_DOMAINS) {
    const matched = matchKeywordsInText(lowered, domain.keywords);
    if (matched.length === 0) continue;
    const confidence = ipcConfidence(matched.length);
    const detail = matchIpcDetail(lowered, domain.section);
    results.push({ section: domain.section, confidence, matchedKeywords: matched, ...detail });
  }

  if (results.length === 0) {
    return [{ section: DEFAULT_IPC_SECTION, confidence: DEFAULT_IPC_CONFIDENCE, matchedKeywords: [] }];
  }
  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * 两级分类第二级：在部内对高频大类关键词子表做二次匹配，
 * 取置信度最高的大类；大类命中 ≥1 词才产出（供消费方按 IPC_DETAIL_MIN_CONFIDENCE 判定精注入）。
 */
function matchIpcDetail(text: string, section: string): { detail: string; detailConfidence: number } | undefined {
  let best: { detail: string; detailConfidence: number } | undefined;
  for (const detailDomain of IPC_DETAIL_DOMAINS) {
    if (detailDomain.section !== section) continue;
    const hits = matchKeywordsInText(text, detailDomain.keywords).length;
    if (hits === 0) continue;
    const detailConfidence = ipcConfidence(hits);
    if (!best || detailConfidence > best.detailConfidence) {
      best = { detail: detailDomain.detail, detailConfidence };
    }
  }
  return best;
}

/** 置信度：0.5 + 0.5*(1 - e^(-hits/K))。饱和函数只依赖绝对命中数，消除关键词表长度偏差。 */
function ipcConfidence(hits: number): number {
  return Math.min(MIN_CONFIDENCE_FOR_KEYWORD + 0.5 * (1 - Math.exp(-hits / CONFIDENCE_SATURATION_K)), 1.0);
}

/** 返回单个最佳分类（与 Mady Classify 一致）。 */
export function classifyIpcTop(text: string): IpcClassification {
  return classifyIpc(text)[0];
}

/** 判断置信度是否为高（>= 0.80）。 */
export function isHighConfidence(confidence: number): boolean {
  return confidence >= HIGH_CONFIDENCE_THRESHOLD;
}

/** 获取某个 IPC 部的领域元数据。 */
export function getIpcDomain(section: string): IpcDomainMeta | undefined {
  return IPC_DOMAINS.find(d => d.section === section.toUpperCase());
}

function matchKeywordsInText(text: string, keywords: string[]): string[] {
  const matched: string[] = [];
  for (const kw of keywords) {
    // text 已在 classifyIpc 中 toLowerCase；关键词表可能含大写 ASCII
    // （GPS/LED 等），统一转小写匹配避免永不命中
    if (text.includes(kw.toLowerCase())) matched.push(kw);
  }
  return matched;
}
