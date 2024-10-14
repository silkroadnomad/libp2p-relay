import winston from 'winston'
import { format } from 'winston'
import { consoleFormat } from 'winston-console-format'
import path from 'path'

// Add this import
import TransportStream from 'winston-transport'

// Add this custom format function
const fileAndLine = format((info) => {
  const originalPrepareStackTrace = Error.prepareStackTrace
  Error.prepareStackTrace = (_, stack) => stack
  const callerStack = new Error().stack
  Error.prepareStackTrace = originalPrepareStackTrace

  if (callerStack && typeof callerStack === 'object') {
    // Find the first stack frame that isn't from logger.js
    const relevantFrame = callerStack.find(frame => {
      const fileName = frame.getFileName()
      return fileName && !fileName.endsWith('logger.js')
    })

    if (relevantFrame) {
      const callerFile = relevantFrame.getFileName()
      const callerLine = relevantFrame.getLineNumber()
      info.caller = `${path.basename(callerFile)}:${callerLine}`
    }
  }
  return info
})

const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    fileAndLine(), // Add this line
    format.timestamp(),
    format.ms(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'relay' },
  transports: [
    new winston.transports.Console({
      format: format.combine(
        format.colorize({ all: true }),
        format.padLevels(),
        consoleFormat({
          showMeta: true,
          metaStrip: ['timestamp', 'service'],
          inspectOptions: {
            depth: Infinity,
            colors: true,
            maxArrayLength: Infinity,
            breakLength: 120,
            compact: Infinity,
          },
        })
      ),
    }),
  ],
})

export default logger
