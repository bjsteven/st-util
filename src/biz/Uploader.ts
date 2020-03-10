/**
 * 上传功能
 * @author bj_steven
 */

import EventClass from '../lib/EventClass'
import deepExtend from 'deep-extend'
import exif from 'exif-js'
import { ajaxPost, ajaxPut } from '../biz/ajax'
import { MapType, CancelableEvent } from '../lib/types'
import { fullUrl } from '../lib/url'

/** 图片类型 */
export enum UploaderImageType {
  gif = 'gif',
  png = 'png',
  jpeg = 'jpeg',
  bmp = 'bmp',
  webp = 'webp'
}

/** 上传选项  */
export interface UploaderOptions {
  /**
   * imagePostUrl 与 filePostUrl 的基础路径，默认 https://mapi.jydata.com
   * 同时，imagePostUrl 或 filePostUrl 也支持带 baseUrl 的全路径，此时，忽略该选项的值
   */
  postUrlBase?: string

  /** 图片上传地址 */
  imagePostUrl?: string
  /** 图片上传字段名 */
  imageFieldName?: string

  /** 文件上传地址 */
  filePostUrl?: string
  /** 文件上传字段名 */
  fileFieldName?: string

  /** 文件上传方式，支持 post、put，默认 post */
  fileSubmitMethod?: 'post' | 'put'

  /**
   * 图片压缩选项，可以设置为 false，禁止对图片进行压缩处理
   * 禁止后，将不会再发出 thumb 事件
   */
  imageCompress?: false | {
    /** 压缩限制 min width，为 null 则不限制 */
    minWidth: number | null
    /** 压缩限制 max width，为 null 则不限制 */
    maxWidth: number | null
    /** 压缩限制 min height，为 null 则不限制 */
    minHeight: number | null
    /** 压缩限制 max height，为 null 则不限制 */
    maxHeight: number | null
    /** 压缩比，用于 canvas 转成 jpeg */
    quality?: number
    /** 保留图片类型列表 */
    keepTypes?: UploaderImageType[]
  }
}

/**
 * 上传项
 */
export interface UploaderItem {
  /** 文件对象 */
  file: File
  /** 文件主类型，例如 'image' */
  type: string
  /** 文件次类型，例如 'jpeg' */
  subtype: string
  /** 图片预览地址 */
  thumb?: string
  /** 图片 width */
  width?: number
  /** 图片 height */
  height?: number
}

/**
 * 预备事件，通过拦截该事件，可以根据一定条件取消上传
 */
export interface UploaderPrepareEvent extends CancelableEvent {
  file: File
}

const defaultOptions: UploaderOptions = {
  postUrlBase: 'https://mapi.jydata.com',
  imagePostUrl: '/file/images',
  imageFieldName: 'images',
  filePostUrl: '/file/miscs',
  fileFieldName: 'files',
  fileSubmitMethod: 'post',
  imageCompress: {
    minWidth: null,
    maxWidth: 1800,
    minHeight: null,
    maxHeight: null,
    quality: 0.9,
    keepTypes: [ UploaderImageType.gif ]
  }
}

const between = (val: number, min: number, max: number, defaultValue: number) => {
  return val >= min && val <= max ? val : defaultValue
}

// 获取图片文件的方向
const getOrientation = (file: File): Promise<{ orientation: number }> => {
  return new Promise(resolve => {
    const reader = new FileReader

    // 读取超过 3s，就取消，但认为方向为 1
    const timer = setTimeout(() => {
      reader.abort()
      resolve({ orientation: 1 })
    }, 3000)

    reader.onload = ({ target }) => {
      clearTimeout(timer)
      let val = 1
      try {
        const buffer = (target as any).result
        const data = exif.readFromBinaryFile(buffer)
        val = parseInt(data.Orientation, 10) || 1
      } catch (ex) {
      }
      resolve({ orientation: between(val, 1, 8, 1) })
    }
  })
}

// 考虑了方向计算图片适合的最大尺寸，更精准，拍照方向请参考 http://www.cnblogs.com/strick/p/5183570.html 中的图示
const suitSize = ({ maxWidth, maxHeight, imgWidth, imgHeight, orientation }: any) => {
  const maxW = orientation < 5 ? maxWidth : maxHeight
  const maxH = orientation < 5 ? maxHeight : maxWidth

  const rate = maxW > 0 && maxH > 0
    ? Math.min(1, maxW / imgWidth, maxH / imgHeight)
    : maxW > 0
    ? Math.min(1, maxW / imgWidth)
    : maxH > 0
    ? Math.min(1, maxH / imgHeight)
    : 1

  return { width: imgWidth * rate, height: imgHeight * rate, rate }
}

// 在 canvas 上按照 width, height 的最大尺寸绘制图片
// 下面的算法来自 https://github.com/stomita/ios-imagefile-megapixel/blob/master/src/megapix-image.js
// 拍照方向请参考 http://www.cnblogs.com/strick/p/5183570.html 中的图示
const drawImage = ({ canvas, image, width, height, orientation }: any) => {
  const context = canvas.getContext('2d')
  canvas.width = orientation < 5 ? width : height
  canvas.height = orientation < 5 ? height : width
  switch (orientation) {
    case 2:
      context.translate(width, 0)
      context.scale(-1, 1)
      break
    case 3:
      context.translate(width, height)
      context.rotate(Math.PI)
      break
    case 4:
      context.translate(0, height)
      context.scale(1, -1)
      break
    case 5:
      context.rotate(0.5 * Math.PI)
      context.scale(1, -1)
      break
    case 6:
      context.rotate(0.5 * Math.PI)
      context.translate(0, -height)
      break
    case 7:
      context.rotate(0.5 * Math.PI)
      context.translate(width, -height)
      context.scale(-1, 1)
      break
    case 8:
      context.rotate(-0.5 * Math.PI)
      context.translate(-width, 0)
      break
  }
  context.drawImage(image, 0, 0, width, height)
}

/**
 * 上传功能类
 */
export default class Uploader extends EventClass {
  private options: UploaderOptions

  public constructor(options = {} as UploaderOptions) {
    super()
    this.options = deepExtend({}, defaultOptions, options)
  }

  public async upload(file: File, data: MapType<any> | FormData = {}) {
    // 发出 perpare 事件，该事件可以通过设置 canceled 拦截接下来的操作
    const ev: UploaderPrepareEvent = { file, canceled: false }
    this.emit('prepare', ev)
    if (ev.canceled) {
      return
    }

    let item: UploaderItem
    try {
      item = await this.prepare(file)
    } catch (ex) {
      return this.emit('fail', ex)
    }

    try {
      this.emit('begin')
      const res = await this.postFile(item, data)
      const resData = res.data || {}
      // TODO: 注意，跟 admin-web、front-web 不同，这里不再假设 res.data 含有 items
      this.emit('done', resData)
      return resData
    } catch (ex) {
      this.emit('fail', ex)
    } finally {
      this.emit('end')
    }
  }

  private async postFile(
    { file, type }: UploaderItem,
    data: MapType<any> | FormData = {}
  ) {
    const {
      postUrlBase,
      imagePostUrl,
      imageFieldName,
      filePostUrl,
      fileSubmitMethod,
      fileFieldName
    } = this.options

    const isImage = type === 'image'

    
    const postUrl = fullUrl(postUrlBase!, isImage ? imagePostUrl! : filePostUrl!)



    const fieldName = isImage ? imageFieldName! : fileFieldName!

    const form = new FormData
    form.append(fieldName!, file, file.name)

    const pairs = data instanceof FormData
      ? Array.from(data)
      : Object.entries(data)
    pairs.forEach(([name, value]) => {
      form.append(name, value)
    })

    return (fileSubmitMethod == 'post' ? ajaxPost : ajaxPut)(postUrl!, form, {
      onUploadProgress: (ev: ProgressEvent) => {
        this.emit('progress', ev)
      }
    })
  }

  // 准备文件，对于图片，按照配置进行压缩等操作
  private async prepare(file: File): Promise<UploaderItem> {
    const [type, subtype = ''] = (file.type || '').split('/')

    const compressOptions = this.options.imageCompress

    if (type === 'image' && compressOptions !== false) {
      return new Promise<UploaderItem>((resolve, reject) => {
        const {
          minWidth,
          maxWidth,
          minHeight,
          maxHeight,
          quality,
          keepTypes
        } = compressOptions!

        const thumb = URL.createObjectURL(file)
        const image = new Image
        image.onload = async () => {
          URL.revokeObjectURL(thumb)

          const { width: imgWidth, height: imgHeight } = image

          const result = {
            file,
            type,
            subtype,
            thumb,
            width: imgWidth,
            height: imgHeight
          }

          // 检查最小宽度、高度
          if (minWidth != null && imgWidth < minWidth) {
            return reject({
              code: 400,
              data: { ...result },
              msg: `图片宽度 ${imgWidth} < 最小宽度 ${minWidth}`
            })
          }
          if (minHeight != null && imgHeight < minHeight) {
            return reject({
              code: 400,
              data: { ...result },
              msg: `图片高度 ${imgHeight} < 最小高度 ${minHeight}`
            })
          }

          this.emit('thumb', { ...result })

          // 是否跳过限制长宽，所有在 keepTypes 的都要直接 PASS
          const shouldPass = keepTypes!.includes(subtype as UploaderImageType)
          if (shouldPass || (maxWidth == null && maxHeight == null)) {
            return resolve(result)
          }

          // 只有 jpeg 才有 orientation 问题
          const orientation = subtype === UploaderImageType.jpeg
            ? (await getOrientation(file)).orientation
            : 1
          const { width, height, rate } = suitSize({
            maxWidth,
            maxHeight,
            imgWidth,
            imgHeight,
            orientation
          }) // tslint:disable-line:align

          // 若缩小范围正好为 1，直接返回
          if (rate == 1) {
            return resolve(result)
          }

          // 在 canvas 上绘制图片，从而达到缩放图片的目的
          const canvas = document.createElement('canvas')
          drawImage({ canvas, image, width, height, orientation })
          canvas.toBlob(
            (blob: any) => {
              // 补全 name 信息（上传需要），所有格式转换成 jpeg 上传
              blob.name = file.name.replace(/\.[^.]+$/i, '.jpg')
              resolve({ ...result, file: blob })
            },
            'image/jpeg',
            quality
          )
        }
        image.onerror = () => {
          reject({
            code: 400,
            data: { file },
            msg: '无法获取预览，请检查是否为图片'
          })
        }
        image.src = thumb
      })
    }
    return { file, type, subtype }
  }
}
