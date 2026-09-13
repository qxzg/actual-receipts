export const recognitionStages = ['preparing', 'waiting', 'thinking', 'generating', 'enriching', 'searching', 'validating'] as const;
export type RecognitionStage = typeof recognitionStages[number];
export type RecognitionModel = { provider: 'api' | 'codex'; model: string };
export type RecognitionProgress = RecognitionModel & { stage: RecognitionStage; startedAt: number };
export type ReportProgress = (stage: RecognitionStage, model: RecognitionModel) => void;
export const stageLabels: Record<RecognitionStage, string> = {
  preparing: '正在准备小票图片', waiting: '等待模型返回', thinking: '模型思考中',
  generating: '正在生成识别结果', enriching: '正在查询商品信息', searching: '正在检索商品来源', validating: '正在整理识别结果',
};
