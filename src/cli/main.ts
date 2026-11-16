import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { parse } from './args.ts'
import { HELP } from './help.ts'
import { execute } from './transport.ts'

const interrupt = new AbortController()
const cancel = interrupt.abort.bind(interrupt)
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)

try {
  const invocation = parse(process.argv.slice(2))
  if (!invocation) {
    process.stdout.write(HELP)
  }
  else {
    const { token, command, timeoutMs, output } = invocation
    const data = await execute(token, command, { timeoutMs, signal: interrupt.signal })
    if (output !== undefined) {
      const png = Buffer.from(data, 'base64')
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('扩展未返回有效 PNG')
      await writeFile(output, png, { flag: 'wx' })
      process.stdout.write(`${resolve(output)}\n`)
    }
    else {
      process.stdout.write(data.endsWith('\n')
        ? data
        : `${data}\n`)
    }
  }
}
catch (error) {
  process.stderr.write(`takeit: ${error instanceof Error
    ? error.message
    : String(error)}\n`)
  process.exitCode = interrupt.signal.aborted ? 130 : 1
}
finally {
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
}
