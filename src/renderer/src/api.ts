import type { MatrixApi } from '../../preload/index';

/** 预加载脚本暴露的 API（类型与 preload 保持同步） */
export const matrix = (window as unknown as { matrix: MatrixApi }).matrix;

export type TaskWithSteps = Awaited<ReturnType<MatrixApi['tasks']['get']>>;
