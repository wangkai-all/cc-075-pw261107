// 检验项目目录与目标时长/排除规则。
// 时长以分钟计。target 是从采样到报告出结果的分段目标：
//   sampleToReceive   采样 → 接收
//   receiveToAnalyze  接收 → 上机
//   analyzeToResult   上机 → 出结果
//   total             采样 → 出结果（端到端目标）
//
// excludeRules 可配置：
//   - status: 要排除的样本状态（如 cancelled）
//   - repeatOnly: 仅统计原始样本，排除复测/重采产生的子样本
//   - maxDelayMinutes: 超过该时长按超时（不参与平均）
//   - excludeOutsideHours: 排除采样时间在配置时段之外的样本
//
// 注意：重采、复测、取消、设备暂停在聚合层分开统计；默认目标口径只算原始样本。

export const TEST_CATALOG = [
  {
    id: 'cbc',
    code: 'CBC',
    name: '血常规',
    department: '检验科',
    target: { sampleToReceive: 30, receiveToAnalyze: 20, analyzeToResult: 45, total: 95 },
    excludeRules: { status: ['cancelled'], repeatOnly: true }
  },
  {
    id: 'coag',
    code: 'PT/APTT',
    name: '凝血功能',
    department: '检验科',
    target: { sampleToReceive: 30, receiveToAnalyze: 15, analyzeToResult: 40, total: 85 },
    excludeRules: { status: ['cancelled'], repeatOnly: true }
  },
  {
    id: 'chem',
    code: 'BIO',
    name: '生化全套',
    department: '检验科',
    target: { sampleToReceive: 30, receiveToAnalyze: 30, analyzeToResult: 70, total: 130 },
    excludeRules: { status: ['cancelled'], repeatOnly: true }
  },
  {
    id: 'trop',
    code: 'hs-cTn',
    name: '高敏肌钙蛋白',
    department: '检验科',
    target: { sampleToReceive: 20, receiveToAnalyze: 10, analyzeToResult: 30, total: 60 },
    excludeRules: { status: ['cancelled'], repeatOnly: true }
  },
  {
    id: 'culture',
    code: 'CULT',
    name: '血培养',
    department: '微生物室',
    target: { sampleToReceive: 60, receiveToAnalyze: 120, analyzeToResult: 2400, total: 2580 },
    excludeRules: { status: ['cancelled'], repeatOnly: true }
  }
];

export function getTest(id, catalog = TEST_CATALOG) {
  return catalog.find(t => t.id === id) || catalog[0];
}

export function sumTargets(...nums) {
  return nums.reduce((a, b) => a + b, 0);
}
