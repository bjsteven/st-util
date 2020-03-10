/// 阿里 OSS 分片并行上传、断点续传，参考：
/// https://help.aliyun.com/document_detail/64047.html
/// @author bj_steven
/// @date 2019-08-21

import deepExtend from 'deep-extend'
import OSS from 'ali-oss'
import md5 from 'md5'
import urlJoin from 'url-join'

import EventClass, { EventMonitor } from '@/lib/EventClass'
import { dot } from '@/lib/object'
import { stringRandom } from '@/lib/string'
import { CancelableEvent } from '@/lib/types'
import tryParseJson from '@/lib/tryParseJson'
import { ajaxGet } from './ajax'

// 默认baseUrl path
const GET_TOKEN_URL_BASE = 'https://fapi.jydata.com'
const GET_TOKEN_URL_PATH = '/file/sts/aiadsFileBucketToken'
/**
 * 文件类型，参见：https://yapi.aiads-dev.com/project/49/interface/api/5869
 */
export enum OssFileType {
  /** 文件 */
  misc = 1,
  /** 图片 */
  image = 2,
  /** 视频 */
  video = 3
}

/**
 * 子目录，参见：https://yapi.aiads-dev.com/project/49/interface/api/5869
 */
export enum OssSubCategory {
  /** 杂项 */
  misc = 1,
  /** 监播视频 */
  monitorVideo = 2,
}

/**
 * 上传参数
 */
export interface OssUploadParam {
  /** 文件类型，默认 OssFileType.misc */
  fileType?: OssFileType
  /** 子目录，默认 OssSubCategory.misc */
  subCategory?: OssSubCategory
  /** 文件扩展名，默认自动提取扩展名，也可以明确指定 */
  fileExtension?: string
}

interface OssUploadParamInner extends OssUploadParam {
  /** 内部使用。resume 模式，是否不判断，直接恢复，默认为 false */
  resume?: boolean
}

/**
 * Oss 项，用于识别不同的文件
 * 从 File 对象中摘取，参见：
 * https://developer.mozilla.org/en-US/docs/Web/API/File
 */
export interface OssItem extends OssUploadParam {
  name: string
  size: number
  type: string
  lastModified: number
}

/**
 * 获取 oss 一系列参数结果
 */
export interface OssToken {
  /** oss 参数 region */
  region: string
  /** oss 参数 bucket */
  bucket: string
  /** oss 参数 stsToken */
  stsToken: string
  /** oss 参数 accessKeyId */
  accessKeyId: string
  /** oss 参数 accessKeySecret */
  accessKeySecret: string
  /** 文件名 */
  fileName: string
}

/**
 * 获取 token 的函数
 */
export type OssGetToken = (param: OssUploadParam, getTokenUrl: string) => Promise<OssToken>

/**
 * 放入本地存储中的信息
 */
export interface OssTrack extends OssItem {
  /** 文件名 */
  fileName: string
  /** 百分比，0 ~ 100 */
  percent: number
  /** oss checkpoint 对象 */
  checkpoint: any
  /** 最近修改时间，毫秒数 */
  lastTime: number
  /** 上传参数 */
  param: OssUploadParam
  /** 将 token 也保存在 track 中 */
  token?: OssToken
}

/** 断点续传使用策略函数参数 */
export interface OssUseCacheParam {
  /** 文件本身 */
  file: File
  /** 缓存中的数据 */
  track: OssTrack
}

/**
 * 断点续传使用策略函数，返回：
 * - yes    使用断点续传
 * - no     不使用断点续传，执行重新上传
 * - cancel 取消上传（即中断上传）
 */
export type OssUseCache = (param: OssUseCacheParam) => Promise<'yes' | 'no' | 'cancel'>

/**
 * 上传选项
 *
 * 继承自 OssUploadParam，可以通过设置 OssUploadParam 的字段，提供 OssUploadParam 的默认选项
 */
export interface OssOptions extends OssUploadParam {
  /** 获取 token 的 url 前缀，默认为 https://fapi.jydata.com */
  getTokenUrlBase?: string
  /** 获取 token 的 url 接口路径，默认为 /file/sts/aiadsFileBucketToken */
  getTokenUrlPath?: string
  /** 获取 token 的函数 */
  getToken?: OssGetToken
  /** 发生错误后的最大重试次数 */
  maxTryCount?: number
  /** 重试超时毫秒数 */
  retryTimeout?: number
  /** Track 过期时间，毫秒数 */
  expireTime?: number
  /** 断点续传使用策略函数 */
  useCache?: OssUseCache
  /** 事件监听者，用于事件代理透传 */
  monitor?: EventMonitor
}

const defaultOptions: OssOptions = {
  // OssUploadParam 的默认选项值
  fileType: OssFileType.misc,
  subCategory: OssSubCategory.misc,
  // 默认baseUrl和path 
  getTokenUrlBase: GET_TOKEN_URL_BASE,
  getTokenUrlPath: GET_TOKEN_URL_PATH,
  async getToken(param: OssUploadParam, getTokenUrl: string) {
    const {
      data: {
        region,
        bucket,
        securityToken: stsToken,
        accessKeyId,
        accessKeySecret,
        fileName
      }
    } = await ajaxGet(getTokenUrl, param)
    return {
      region,
      bucket,
      stsToken,
      accessKeyId,
      accessKeySecret,
      fileName
    }
  },
  maxTryCount: 3,
  retryTimeout: 3000,
  expireTime: 24 * 60 * 60 * 1000,
  // 默认的断点续传策略
  // NOTE: 下面的代码，必须放在相应的 UI 库里，因为 triple 是 UI 相关的代码
  // async useCache({ track }) {
  //   return new Promise(async resolve => {
  //     const { percent } = track
  //     const percentText = +percent.toFixed(1)
  //     const yes = await triple(`发现该文件上次已上传到 ${percentText}%`, {
  //       yesText: '断点续传',
  //       noText: '重新上传',
  //       onCancel: () => resolve('cancel')
  //     })
  //     resolve(yes ? 'yes' : 'no')
  //   })
  // }
}

const getOssItem = (file: File, param: OssUploadParam) => {
  const item: OssItem = {
    ...param,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified
  }
  return item
}

const getHash = (value: any) => {
  const json = JSON.stringify(value)
  const hash = md5(json)
  return hash
}

// 获取扩展名，file.tar.zip => .tar.zip
const getExt = (name = '') => name && name.replace(/^[^.]+/, '')

const newTrack = (item: OssItem, hash: string, param: OssUploadParam) => {
  // 保留扩展名
  const ext = param.fileExtension
  const track: OssTrack = {
    ...item,
    // 预防重复，会被覆盖
    fileName: stringRandom('upload', hash) + ext,
    percent: 0,
    checkpoint: null,
    lastTime: Date.now(),
    param,
  }
  return track
}

const storageKeyPrefix = '@ossuploadtrack'

// 清除 localStorage 内已过期的 Track
const cleanTracks = (expireTime: number) => {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith(storageKeyPrefix)) {
      const json = localStorage.getItem(key)
      const item = tryParseJson(json)
      if (item != null && item.lastTime > 0) {
        const dtime = Date.now() - item.lastTime
        if (dtime > expireTime) {
          localStorage.removeItem(key)
        }
      }
    }
  })
}

// 将 track 保存在本地存储
const saveTrack = (track: OssTrack, hash: string) => {
  const json = JSON.stringify(track)
  // devLog('saveTrack', track, json)
  const key = storageKeyPrefix + hash
  localStorage.setItem(key, json)
}

// 从本地存储中获取 track
const getTrack = (hash: string) => {
  const key = storageKeyPrefix + hash
  const json = localStorage.getItem(key)
  const track = tryParseJson(json) as OssTrack | null
  return track
}

// 从本地存储中获取 track
const delTrack = (hash: string) => {
  const key = storageKeyPrefix + hash
  localStorage.removeItem(key)
}

interface OssUploadIntent {
  tryCount: number
  item: OssItem
  hash: string
  track: OssTrack
  resume: boolean
}

/**
 * 本组件特定的事件对象
 */
export interface OssUploaderEvent {
  file: File
}

/** 已经获取 token 事件 */
export interface OssAfterGetTokenEvent extends OssUploaderEvent {
  token: OssToken
}

/**
 * 进度事件对象
 */
export interface OssProgressEvent extends OssUploaderEvent {
  /** 进度百分比，0 ~ 100 */
  percent: number
  /** oss checkpoint 对象 */
  checkpoint: any
}

/**
 * 上传成功事件对象
 */
export interface OssDoneEvent extends OssUploaderEvent {
  /** 上传后的 url */
  url: string
  /** 服务器返回的原始结果 */
  result: any
}

/**
 * 上传失败事件对象
 */
export interface OssFailEvent extends OssUploaderEvent {
  /** 异常对象 */
  exception: any
}

/** 即将重试事件对象 */
export interface OssBeforeRetryEvent extends OssUploaderEvent, CancelableEvent {
  /** 第几次重试，最初的一次，作为第 0 次 */
  tryCount: number
  /** 重试的最大个数 */
  maxTryCount: number
}

/**
 * Oss 上传
 */
export default class OssUploader extends EventClass {
  private options: OssOptions

  private client: OSS | null = null

  private file: File | null = null

  private hash: string | null = null

  private isPausedInner = false

  private hasBegin = false

  public constructor(options = {} as OssOptions) {
    super({ monitor: options.monitor })
    this.options = deepExtend({}, defaultOptions, options)
  }

  public get isPaused() {
    return this.isPausedInner
  }

  /**
   * 上传文件
   * @param file 文件对象
   * @param param 参数，该参数覆盖选项中的同名字段，更详尽描述，参见 [[OssUploadParam]] 类型
   */
  public async upload(
    file: File,
    {
      fileType,
      subCategory,
      fileExtension,
      resume = false
    }: OssUploadParamInner = {}
  ) {
    const {
      fileType: defaultFileType,
      subCategory: defaultSubCategory,
      fileExtension:  defaultFileExtension,
      expireTime,
      useCache
    } = this.options

    cleanTracks(expireTime!)

    // 取扩展名，策略：优先使用传入参数，其次取选项中的值，最后根据文件名获取，一般情况下，应根据文件名获取
    const ext = (fileExtension || defaultFileExtension || getExt(file.name) || '').replace(/^\./, '').toLowerCase()

    // 上传参数取值，策略：优先使用传入参数，其次取选项中的值
    const param: OssUploadParam = {
      fileType: fileType || defaultFileType,
      subCategory: subCategory || defaultSubCategory,
      fileExtension: ext
    }

    const item = getOssItem(file, param)
    const hash = getHash(item)
    const cachedTrack = getTrack(hash)

    let track = newTrack(item, hash, param)

    if (cachedTrack != null) {
      // 当缓存中的数据存在时，执行断点续传使用策略函数
      const cacheResult = resume
        ? 'yes'
        : await useCache!({ file, track: cachedTrack })

      if (cacheResult == 'cancel') {
        return
      }

      if (cacheResult == 'yes') {
        // 恢复 file，本地存储（JSON）无法保存 file 引用
        cachedTrack.checkpoint.file = file
        track = cachedTrack
        resume = true
      } else {
        resume = false
      }
    } else {
      resume = false
    }

    this.uploadWork(file, {
      tryCount: 0,
      item,
      hash,
      track,
      resume
    })
  }

  /**
   * 暂停上传
   */
  public pause() {
    const client = this.client as any
    if (client != null && !this.isPaused) {
      // cancel 方法未在文档中说明
      client.cancel()
      this.setIsPaused(true)
    }
  }

  /**
   * 恢复上传
   */
  public resume() {
    if (this.isPaused) {
      this.upload(this.file!, { resume: true })
    }
  }

  /**
   * 停止或中断上传，多次调用无副作用
   */
  public stop() {
    this.pause()
    this.end()
    this.clean()
  }

  private clean() {
    if (this.hash) {
      delTrack(this.hash)
      this.hash = null
      this.file = null
    }
  }

  private end() {
    if (this.hasBegin) {
      this.hasBegin = false
      // 发出结束事件，这个是全局的结束
      this.emit('end')
    }
  }

  private async uploadWork(
    file: File,
    {
      tryCount = 0,
      item,
      hash,
      track,
      resume = false
    }: OssUploadIntent
  ) {
    const { getToken, getTokenUrlBase, getTokenUrlPath, maxTryCount, retryTimeout } = this.options

    const getTokenUrl = urlJoin(getTokenUrlBase || '', getTokenUrlPath || '')

    try {
      if (tryCount == 0) {
        // 发出开始事件，这个是全局的开始
        this.emit('begin')
        this.setIsPaused(false)
        this.hasBegin = true
        // 将 file 保存下来，以便 pause 后 resume
        this.file = file
        this.hash = hash
      }

      const token = resume && track.token || await (async () => {
        // 发出将要获取 token 事件
        this.emit('beforeGetToken')

        const ret = await getToken!(track.param, getTokenUrl)
        // 更新 fileName，使用服务器端返回的
        track.fileName = ret.fileName
        track.token = ret
        saveTrack(track, hash)

        // 发出已经获取 token 事件
        const afterGetTokenEvent: OssAfterGetTokenEvent = { file, token: ret }
        this.emit('afterGetToken', afterGetTokenEvent)

        return ret
      })()

      const client = this.client = new OSS(token)

      const { fileName, checkpoint: savedCheckPoint } = track

      // 发出准备事件（multipartUpload 会进行分片等耗时操作）
      this.emit('prepare')
      const result = await client.multipartUpload(fileName, file, {
        // 支持从 checkpoint 恢复
        checkpoint: savedCheckPoint,
        progress: (p, checkpoint) => {
          const percent = p * 100
          const progressEvent: OssProgressEvent = {
            file,
            percent,
            checkpoint,
          }
          this.emit('progress', progressEvent)
          track.percent = percent
          track.checkpoint = checkpoint
          track.lastTime = Date.now()
          saveTrack(track, hash)
          // devLog('=> p', p, ' checkpoint', checkpoint)
        }
      })

      const url = (dot(result, 'res.requestUrls[0]') || '').replace(/\?uploadId=.*/, '')
      // devLog(url, result)

      // 发出上传成功 done 事件
      const doneEvent: OssDoneEvent = { file, url, result }
      this.emit('done', doneEvent)

      this.clean()
    } catch (ex) {
      // 判断是否是取消
      if (ex && ex.status == 0 && ex.name == 'cancel') {
        return
      }

      // 发出上传失败 fail 事件
      const failEvent: OssFailEvent = { file, exception: ex }
      this.emit('fail', failEvent)

      // 重试逻辑
      const nextTryCount = tryCount + 1

      if (nextTryCount <= maxTryCount!) {
        // 发出 beforeRetry 事件，该事件可以通过设置 anceled 拦截接下来的操作
        const beforeRetryEvent: OssBeforeRetryEvent = {
          file,
          canceled: false,
          tryCount: nextTryCount,
          maxTryCount: maxTryCount!
        }
        this.emit('beforeRetry', beforeRetryEvent)
        if (beforeRetryEvent.canceled) {
          return this.end()
        }

        setTimeout(() => {
          this.uploadWork(file, {
            tryCount: nextTryCount,
            item,
            hash,
            track,
            resume: false,
          })
        }, retryTimeout)
      } else {
        this.end()
      }
    }
  }

  private setIsPaused(value: boolean) {
    if (value != this.isPausedInner) {
      this.isPausedInner = value
      this.emit('isPausedChanged', value)
    }
  }
}
