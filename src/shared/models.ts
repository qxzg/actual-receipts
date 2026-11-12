export type ModelOption = { id: string; name: string; description: string; isDefault: boolean; vision: boolean | null };
export function modelDescription(vision: boolean | null): string {
  return vision === true ? '服务商标注支持图片，可用于小票识别。' : vision === false ? '服务商标注为文本输入模型。' : '服务商提供的模型，选择后请测试图片能力。';
}
