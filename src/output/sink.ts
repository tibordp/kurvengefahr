// Output sink: where emitted G-code goes. v1 is a file download; PrusaLink/PrusaConnect
// upload or Web Serial are drop-in implementations of the same interface later.
export interface OutputSink {
  name: string
  send(filename: string, content: string): Promise<void>
}

export const downloadSink: OutputSink = {
  name: 'Download',
  async send(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
}
