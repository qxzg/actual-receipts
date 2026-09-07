export type ModelOption = { id: string; name: string; description: string; isDefault: boolean; vision: boolean | null };
// Brief task guidance based on official model descriptions, not measured receipt accuracy.
const descriptions: Record<string, string> = {
  'gpt-6-astra': '面向复杂任务，适合疑难小票与细致核对。',
  'gpt-5.6-sol': '擅长复杂推理，适合多项费用与多图核对。',
  'gpt-5.6-terra': '兼顾能力与效率，适合日常小票识别。',
  'gpt-5.6-luna': '轻量高效，适合清晰、格式规整的小票。',
  'gpt-5.5': '通用推理模型，可用于商品提取与分类。',
  'gpt-5.4-mini': '轻量模型，适合简单图片提取；使用前测试图片能力。',
};
export function modelDescription(id: string, vision: boolean | null): string {
  return descriptions[id] || (vision === true ? '服务商标注支持图片，可用于小票识别。' : vision === false ? '服务商标注为文本输入模型。' : '服务商提供的模型，选择后请测试图片能力。');
}
