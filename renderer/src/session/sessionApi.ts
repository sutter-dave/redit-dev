

//===========================
// Type Definitions
//===========================

/** This is the format for a command argument in the function sendCmd and multiCmd */
export type CodeCommand = {
    type: string,
    lineId: string,
    code?: string,
    after?: number
}

//session message from rsession
export type SessionMsg = {
    type: string
    session: string
    data: any
}

//event messages to client
export type PlotPayload = {
    type: "plot",
    session: string,
    lineId: string,
    data: string
}

export type ConsolePayload = {
    type: "console",
    session: string | null,
    lineId: string | null, 
    msgType: "stdout" | "stderr",
    msg: string
}

export type EvalFinishPayload = {
    type: "evalFinish",
    session: string, 
    lineCompleted: string | null
    nextIndex: number | null
}

export type EvalStartPayload = {
    type: "evalStart",
    session: string, 
    lineId: string
}

/** This is the format used in the sendCommand function for a RSession request. */
type SessionRequestWrapper = {
    scope: string
    method: string
    params: any[]
    processResponse?: ((arg0: any) => void)
}

/** This is the format of a response from the RSession. */
type SessionResponse = any

//===========================
// Fields
//===========================

const MESSAGE_START1 = '[1] "|$($|'
const MESSAGE_START2 = ' "|$($|'
const MESSAGE_END = '|$)$|"'
const MESSAGE_PREFIX1 = '[1] '
const MESSAGE_PREFIX2 = ' '
const MESSAGE_HEADER = '|$($|'
const MESSAGE_FOOTER = '|$)$|'

let DUMMY_CMD: SessionRequestWrapper = {scope: 'rpc', method: 'console_input', params: ["111","",0]}
let DISPLAY_INIT_CMD: SessionRequestWrapper = {scope: "rpc" , method: "set_workbench_metrics", params: [{
    "consoleWidth":120, 
    "buildConsoleWidth":120, 
    "graphicsWidth":600, 
    "graphicsHeight":300, 
    "devicePixelRatio":1
}]}

let listeners: Record<string,((eventName: string, data: any) => void)[]>  = {}

let initComplete = false
let eventIndex = 0

let firstPass = true
let continueEvents = true

let activeSession: string | null = null
let activeLineId: string | null = null
let lineActive: boolean = false

//===========================
// Main Functions
//===========================

//R SESSION LISTENER

export function startSessionListener() {   
    if(firstPass) {
        //send a dummy command
        sendCommand(DUMMY_CMD)
    }

    //start event listener
    listenForEvents()
}

export function stopSessionListener() {
    continueEvents = false;
}

//CLIENT LISTENER

export function addEventListener(eventName: string, callback: (eventName: string, data: any) => void ) {
    let listenerList = listeners[eventName]
    if(listenerList === undefined) {
        listenerList = []
        listeners[eventName] = listenerList
    }
    listenerList.push(callback)
}


export function randomIdString() {
    //Make the biggest positive int random number possible (it doesn't have to be positive really)
    //and express it as a string in the largest base possible
    //Prefix with a letter ("f" for field) so we can use this as a field name symbol in R (as in data$f4j543k45) 
    return "f" + Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(32)
}

//---------------------------
// Commands
//---------------------------

export function initDoc(docSessionId: string) {
    sendRCommand(`initializeDocState("${docSessionId}")`)
}

export function addCmd(docSessionId: string, lineId: string, code: string, after: number) {
    sendRCommand(`addCmd("${docSessionId}","${lineId}",${JSON.stringify(code)},${after})`)
}

export function updateCmd(docSessionId: string, lineId: string, code: string) {
    sendRCommand(`updateCmd("${docSessionId}","${lineId}",${JSON.stringify(code)})`)
}

export function deleteCmd(docSessionId: string, lineId: string) {
    sendRCommand(`deleteCmd("${docSessionId}","${lineId}")`)
}

export function multiCmd(docSessionId: string, cmds: CodeCommand[] ) {
    let childCmdStrings = cmds.map(cmdToCmdListString)
    let childCmdListString = "list(" + childCmdStrings.join(",") + ")"
    //let cmdString = `list(type="multi",cmds=${childCmdListString})`
    sendRCommand(`multiCmd("${docSessionId}",${childCmdListString})`)
}

export function rawCmd(docSessionId: string, cmd: CodeCommand) {
    sendRCommand(`executeCommand("${docSessionId}",${cmdToCmdListString(cmd)})`)
}

export function evaluateCmd(docSessionId: string) {
    sendRCommand(`evaluate("${docSessionId}")`)
}

//=================================
// internal functions
//=================================

//---------------------------
// Command Helpers
//---------------------------

function cmdToCmdListString(cmd: CodeCommand) {
    let cmdListString = `list(type="${cmd.type}",lineId="${cmd.lineId}"`
    if(cmd.code !== undefined) {
        cmdListString += `,code=${JSON.stringify(cmd.code)}`
    }
    if(cmd.after !== undefined) {
        cmdListString += `,after=${cmd.after}`
    }
    cmdListString += ")"
    return cmdListString
}

function sendRCommand(rCode: string) {
    if(!initComplete) {
        throw new Error("R command can not be sent becaues init is not yet completed")
    }
    sendCommand({scope: 'rpc', method: 'execute_code', params: [rCode]})
}

//--------------------------
//-------------------------

function dispatch(eventName: string, data: any) {
    let listenerList = listeners[eventName]
    if(listenerList !== undefined) {
        listenerList.forEach(callback => callback(eventName,data))
    }
}



//----------------------------
// Event listener functions
//----------------------------

function listenForEvents() {
    try {
        getEvents()
    }
    catch(err: any) {
        console.log("Error in event listener loop!")
        console.log(err.toString())
        //issue another event request
        continueListener()
    }
}

const EVENT_DELAY = 10 //this is thrown in just because
function continueListener() {
    if(continueEvents) {
        setTimeout(listenForEvents,EVENT_DELAY)
    }
}

//-------------------------
// Events handler functions
//-------------------------

function onInitComplete() {
    initComplete = true
    //console.log("R session init complete!")

    //r session is initialized
    //repdoc session is not really intialized until after these
    sendCommand(DISPLAY_INIT_CMD)
    sendRCommand('require(repdoc)')
    sendRCommand(`initializeSession()`)

    dispatch("initComplete",null)
}

function onPlotReceived(fileRef: string) {
    let session = activeSession
    let lineId = activeLineId
    //get plot data as base64
    window.rSessionApi.getBinary(fileRef).then( (response: any) => {  
        dispatch("stateUpdate",[{type: "plot", session: session, lineId: lineId, data: response.data}])
    })
    .catch(err => {
        console.error("Error getting graphics file:")
        console.error(err.toString())
        getConsoleEvent("stderr", "Error getting plot data: " + err.toString(), true)
    })
}

function onConsoleOut(text: string) {
    let stateEventList: any[] = []

    let lines = text.split("\n")
    lines.forEach(line => {
        //I don't know why, but the session messages seem to end up inn two different formats
        //when they come out the console
        if(line.endsWith(MESSAGE_END)) {
            let msgChars = null
            if(line.startsWith(MESSAGE_START1)) {
                msgChars = JSON.parse(line.slice(MESSAGE_PREFIX1.length))
            }
            else if(line.startsWith(MESSAGE_START2)) {
                msgChars = JSON.parse(line.slice(MESSAGE_PREFIX2.length))
            }
            else {
                //Whst do I do here?
                console.log("SOMETHING HAPPENED!")
            }

            if(msgChars !== null) {
                try {
                    let msgJson = JSON.parse(msgChars.slice(MESSAGE_HEADER.length,-MESSAGE_FOOTER.length))
                    let eventPayload = processSessionMsgEvent(msgJson)
                    stateEventList.push(eventPayload)
                }
                catch(error: any) {
                    console.error("Error parsing msg body from session: " + error.toString())
                }
                return
            }
        }
        else {
            stateEventList.push(getConsoleEvent("stdout",line))
        }
    })

    dispatch("stateUpdate",stateEventList)
}

function onConsoleErr(msg: string) {
    dispatch("stateUpdate", [getConsoleEvent("stderr",msg)])
}

function getConsoleEvent(msgType: string, msg: string, forceLineId: boolean = false) {
    //console output only comes when a line is active 
    //allow to force the line id, usually for other error messages
    return {
        type: "console",
        session: activeSession,
        lineId: (lineActive || forceLineId) ? activeLineId : null,
        msgType: msgType,
        msg: msg
    }
}

function processSessionMsgEvent(msgJson: SessionMsg) {
    try {
        switch(msgJson.type) {
            case "docStatus": 
                //Doc status triggers the end of the current active line, if there is one
                //Note that plot data can/will come in afterwards
                //So keep the activeSession and associated activeLineId
                lineActive = false
                //Doc status also tells if there are more lines to evaluate
                //This should be the same session as above, I think. If so, does enforcing that matter? 
                if(msgJson.data.evalComplete === false) {
                    //more lines to evaluate
                    evaluateCmd(msgJson.session)
                }

                if(msgJson.session !== activeSession) {
                    //IS THERE SOMETHING I SHOULD DO HERE?
                    console.log("Session msg Event not equal to active session")
                }

                return {
                    type: "evalFinish",
                    session: msgJson.session, 
                    lineCompleted: (msgJson.session == activeSession) ? activeLineId : null,  //the sessions should be equal
                    nextIndex: msgJson.data.nextIndex //maybe
                } 

            case "evalStart": {
                //Eval start triggers a new active line
                activeSession = msgJson.session
                activeLineId = msgJson.data
                lineActive = true

                return {
                    type: "evalStart",
                    session: msgJson.session, 
                    lineId: activeLineId
                } 
            }

            default:
                console.log("Unknown message: " + JSON.stringify(msgJson,null,4))
                break
        }
    }
    catch(err: any) {
        if(err && msgJson) {
            console.log("Error processing mesasge: " + err.toString() + " - " + msgJson.toString())
        }
    }
}

//-------------------------
// RPC Functions
//-------------------------

/** This function sends a generic RPC command. If the command includes a field "processResponse",
 * this is called to process the response. The response json is also printed. */
function sendCommand(cmd: SessionRequestWrapper) {
    console.log("Send command: " + JSON.stringify(cmd))
    window.rSessionApi.sendRpcRequest(cmd.scope,cmd.method,cmd.params).then( (response: SessionResponse) => {
        console.log("Command response: " + JSON.stringify(response))

        if(cmd.processResponse) cmd.processResponse!(response)
    }).catch(e => {
        if(e) console.log(e.toString())
        else console.log("Unknown error in request")
    })
}

/** This funtion listens for and processes events. */
function getEvents() {
    let scope = "events"
    let method = "get_events"
    let params = [eventIndex]
    window.rSessionApi.sendRpcRequest(scope,method,params).then( (response: SessionResponse) => {
        if(response.data.result) {
            response.data.result.forEach( (entry: any,index: number) => {
                
                console.log(`type: ${entry.type}, index: ${index}`)
                console.log(JSON.stringify(entry))

                if(entry.type == "deferred_init_completed") {
                    //init complete
                    onInitComplete()
                }
                else if(entry.type == "plots_state_changed") {
                    onPlotReceived(entry.data.filename)
                }

                else if(entry.type == "console_output") {
                    onConsoleOut(entry.data.text)
                }
                // else if(entry.type == "console_wite_prompt") {
                //     console.log("console prompt:")
                //     console.log(entry.data)
                // }
                else if(entry.type == "console_error") {
                    onConsoleErr(entry.data.text)
                }
                // else {
                //     console.log("Unkown: " + entry.type)
                //     console.log(JSON.stringify(entry))
                // }

                eventIndex = entry.id
            })
        }
        else {
            //console.log("Empty result in events")
        }

        continueListener()

    }).catch(e => {
        if(e) console.log(e.toString())
        else console.log("Unknown error in request")

        continueListener()
    })
}

