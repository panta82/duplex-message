export type IHandlerMap = Record<string, Function>

export interface IRequest {
  fromInstance: string
  toInstance?: string
  messageID: number
  type: 'request'
  methodName: string,
  args: any[]
  progress?: boolean
  [k: string]: any
}

export interface IResponse {
  fromInstance: string
  toInstance: string
  messageID: number
  type: 'response'
  isSuccess: boolean
  data: any
}

export interface IProgress {
  fromInstance: string
  toInstance: string
  messageID: number
  type: 'progress'
  data: any
}

export interface IMethodNameConfig {
  methodName: string
  [k: string]: any
}

export abstract class AbstractHub {
  /**
   * hub instance 
   */
  readonly instanceID: string

  protected readonly _responseCallbacks: ((...args: any[]) => number)[]

  protected _messageID: number
  /**
   * message handler map
   *  array item struct: eventTarget, {eventName: eventHandler } | handler4AllEvents
   */
  protected readonly _eventHandlerMap: Array<[any, IHandlerMap | Function]>

  /**
   * init Hub, subclass should implement its own constructor
   */
  constructor () {
    this.instanceID = AbstractHub.generateInstanceID()
    this._eventHandlerMap = []
    this._responseCallbacks = []
    this._messageID = 0
  }

  /**
   * subclass' own off method, should use _off to implements it
   * @param args args to off method, normally are target and methodName
   */
  abstract off (...args: any[]): void
  
  /**
   * subclass' own on method, should use _on to implements it
   * @param args args to listen method, normally are target, methodName and method
   */
  abstract on (...args: any[]): void

  /**
   * subclass' own emit method, should use _emit to implements it
   * @param args args to emit message, normally are target, methodName and method's params
   */
  abstract emit (...args: any[]): void

  /**
   * subclass' own send message method, should send msg to target
   * @param target peer to receive message. if only one/no specified peer, target will be *
   * @param msg message send to peer
   */
  protected abstract sendMessage (target: any, msg: IRequest | IProgress | IResponse): void


  protected _hasListeners () {
    return this._eventHandlerMap.length > 0
  }
  /**
   * add listener for target
   */
  protected _on (target: any, handlerMap: Function | IHandlerMap): void
  protected _on (target: any, methodName: string, handler: Function): void
  protected _on (target: any, handlerMap: IHandlerMap | Function | string, handler?: Function): void {
    const pair = this._eventHandlerMap.find(pair => pair[0] === target)
    let handlerResult: Function | IHandlerMap
    if (typeof handlerMap === 'string') {      
      handlerResult = { [handlerMap]: handler! }
    } else {
      handlerResult = handlerMap
    }
    if (pair) {
      const existingMap = pair[1]
      // merge existing handler map
      // @ts-ignore
      pair[1] = typeof existingMap === 'function' ?
        handlerResult : typeof handlerResult === 'function' ?
          handlerResult : Object.assign({}, existingMap, handlerResult)

      return
    }
    this._eventHandlerMap[target === '*' ? 'unshift' : 'push']([target, handlerResult])
  }


  protected _off (target: any, methodName?: string) {
    const index = this._eventHandlerMap.findIndex(pair => pair[0] === target)
    if (index === -1) return
    if (!methodName) {
      this._eventHandlerMap.splice(index, 1)
      return
    }
    const handlerMap = this._eventHandlerMap[index][1]
    if (typeof handlerMap === 'object') {
      delete handlerMap[methodName]
      // nothing left
      if (!Object.keys(handlerMap).length) {
        this._eventHandlerMap.splice(index, 1)
      }
    }
  }

  protected async _onMessage (target: any, msg: any) {
    if (!msg) return
    if (!this._isRequest(msg)) {
      let ret = 0
      const idx = this._responseCallbacks.findIndex(fn => {
        ret = fn(msg)
        return Boolean(ret)
      })
      if (idx >= 0) {
        if (ret > 1) return
        this._responseCallbacks.splice(idx, 1)
      }
      return
    }
    if (msg.progress && msg.args[0]) {
      msg.args[0].onprogress = (data: any) => {
        this.sendMessage(target, this._buildProgressMessage(data, msg))
      }
    }
    let response: IResponse
    try {
      response = await this._runMsgCallback(target, msg)
    } catch (error) {
      response = error
    }
    this.sendMessage(target, response)
  }

  async _runMsgCallback (target: any, reqMsg: IRequest) {
    try {
      const matchedMap = this._eventHandlerMap.find(wm => wm[0] === target) ||
        // use * for default
        (this._eventHandlerMap[0] && this._eventHandlerMap[0][0] === '*' && this._eventHandlerMap[0])
      const { methodName, args } = reqMsg
      const handlerMap = matchedMap && matchedMap[1]
      // handler map could be a function
      let method: Function
      if (typeof handlerMap === 'function') {
        method = handlerMap
        // add methodName as the first argument if handlerMap is a function
        args.unshift(methodName)
      } else {
        // @ts-ignore
        method = handlerMap && handlerMap[methodName]
      }
      // tslint:disable-next-line
      if (typeof method !== 'function') {
        console.warn(`[MessageHub] no corresponding handler found for ${methodName}, message from`, target)
        throw new Error(`[MessageHub] no corresponding handler found for ${methodName}`)
      }
      const data = await method.apply(null, args)
      return this._buildRespMessage(data, reqMsg, true)
    } catch (error) {
      throw this._buildRespMessage(error, reqMsg, false)
    }
  }

  protected _emit (target: any, methodName: string | IMethodNameConfig, ...args: any[]) {
    const reqMsg = this._buildReqMessage(methodName, args)
    this.sendMessage(target, this._normalizeRequest(target, reqMsg))
    return new Promise((resolve, reject) => {
      // 0 for not match
      // 1 for done
      // 2 for need to be continue
      const callback = (response: IResponse | IProgress) => {
        if (!this._isResponse(reqMsg, response)) {
          if (!this._isProgress(reqMsg, response)) return 0
          if (reqMsg.args[0] && typeof reqMsg.args[0].onprogress === 'function') {
            try {
              reqMsg.args[0].onprogress(response.data)
            } catch (error) {
              console.warn('progress callback for', reqMsg, 'response', response, ', error:', error)
            }
          }
          return 2
        }
        response.isSuccess ? resolve(response.data) : reject(response.data)
        return 1
      }
      this._listenResponse(target, reqMsg, callback)
    })
  }
  /**
   * should get response from target and pass response to callback
   */
  protected _listenResponse (target: any, reqMsg: IRequest, callback: (resp: IResponse) => number) {
    this._responseCallbacks.push(callback)
  }

  // normalize progress callback on message
  protected _normalizeRequest(target: any, msg: IRequest) {
    // skip if target is * 
    if (target === '*') return msg
    const options = msg.args[0]
    if (!options || typeof options.onprogress !== 'function') return msg
    const newMsg = Object.assign({}, msg, { progress: true })
    newMsg.args = newMsg.args.slice()
    const copied = Object.assign({}, options)
    delete copied.onprogress
    newMsg.args[0] = copied

    return newMsg
  }

  protected _buildReqMessage (methodName: string | IMethodNameConfig, args: any[]): IRequest {
    const basicCfg = typeof methodName === 'string' ? { methodName } : methodName
    // @ts-ignore
    return Object.assign(basicCfg, {
      fromInstance: this.instanceID,
      // toInstance,
      messageID: ++this._messageID,
      type: 'request',
      args
    })
  }

  protected _buildRespMessage (data: any, reqMsg: IRequest, isSuccess: boolean): IResponse {
    return {
      fromInstance: this.instanceID,
      toInstance: reqMsg.fromInstance,
      messageID: reqMsg.messageID,
      type: 'response',
      isSuccess,
      data
    }
  }

  protected _buildProgressMessage (data: any, reqMsg: IRequest): IProgress {
    return {
      fromInstance: this.instanceID,
      toInstance: reqMsg.fromInstance,
      messageID: reqMsg.messageID,
      type: 'progress',
      data
    }
  }

  protected _isRequest (reqMsg: any): reqMsg is IRequest {
    return Boolean(reqMsg && reqMsg.fromInstance &&
      reqMsg.fromInstance !== this.instanceID &&
      (!reqMsg.toInstance || (reqMsg.toInstance === this.instanceID)) &&
      reqMsg.messageID && reqMsg.type === 'request')
  }

  protected _isResponse (reqMsg: IRequest, respMsg: any): respMsg is IResponse {
    return reqMsg && reqMsg && 
      respMsg.toInstance === this.instanceID &&
      respMsg.toInstance === reqMsg.fromInstance && 
      respMsg.messageID === reqMsg.messageID &&
      respMsg.type === 'response'
  }

  protected _isProgress (reqMsg: IRequest, respMsg: any): respMsg is IProgress {
    return reqMsg && reqMsg && 
      respMsg.toInstance === this.instanceID &&
      respMsg.toInstance === reqMsg.fromInstance && 
      respMsg.messageID === reqMsg.messageID &&
      respMsg.type === 'progress'
  }

  static generateInstanceID () {
    return Array(3).join(Math.random().toString(36).slice(2) + '-').slice(0, -1)
  }
}
