///
/// 通用类型，非通用的不要声明在这里
///

/**
 * 通用 Map 泛型，为了与新标准中的 Map 类相区分，这里使用名称 MapType
 */
export interface MapType<T = any> {
  [key: string]: T
  [index: number]: T
}

/** 可取消的事件 */
export interface CancelableEvent {
  /** 是否取消 */
  canceled: boolean
}
