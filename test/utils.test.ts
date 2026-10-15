import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOutputFilePath } from '../src/extractor/utils.js'
import { getFileChecker, normalizeFileName, patchLinks } from '../src/utils.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('normalizeFileName', () => {
  it('converts composed and decomposed accented names to the same ascii filename', () => {
    expect(normalizeFileName('Ilustración_sin_título.mp4')).toBe(
      'Ilustracion_sin_titulo.mp4'
    )
    expect(normalizeFileName('Ilustración_sin_título.mp4')).toBe(
      'Ilustracion_sin_titulo.mp4'
    )
  })

  it('applies fallback transliterations that unicode decomposition does not cover', () => {
    expect(normalizeFileName('Łódź-ßpecial-Œuvre.mp4')).toBe(
      'Lodz-sspecial-OEuvre.mp4'
    )
  })

  it('drops path segments before normalizing', () => {
    expect(normalizeFileName('../nested/Crème brûlée.txt')).toBe(
      'Creme brulee.txt'
    )
  })
})

describe('getFileChecker', () => {
  it('matches an existing file across unicode normalization forms', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patron-hamster-checker-'))
    tempDirs.push(dir)
    const storedName = 'Ilustración_sin_título.mp4'
    fs.writeFileSync(path.join(dir, storedName), 'fixture')

    const checker = getFileChecker(dir)

    expect(checker('Ilustración_sin_título.mp4')).toBe(storedName)
  })

  it('re-reads the directory so files created after checker construction are visible', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patron-hamster-checker-'))
    tempDirs.push(dir)
    const checker = getFileChecker(dir)
    const storedName = 'Cafe_con_leche.mp4'

    fs.writeFileSync(path.join(dir, storedName), 'fixture')

    expect(checker('Café_con_leche.mp4')).toBe(storedName)
  })
})

describe('resolveOutputFilePath', () => {
  it('writes attachments with normalized ascii basenames', () => {
    expect(resolveOutputFilePath('/tmp/out', 'Ilustración_sin_título.mp4')).toBe(
      path.resolve('/tmp/out', 'Ilustracion_sin_titulo.mp4')
    )
  })
})

describe('patchLinks', () => {
  it('replaces attachment hrefs with post-scoped relative paths', () => {
    const html = '<div><a href="https://files.example/video.mp4" download="video.mp4">clip</a></div>'
    const patched = patchLinks({
      html,
      imageMap: {},
      site: 'pixivFanbox',
      attachments: [
        {
          href: 'https://files.example/video.mp4',
          fileName: 'video.mp4',
          path: '168038234/video.mp4'
        }
      ]
    })

    expect(patched).toContain('src="168038234/video.mp4"')
    expect(patched).toContain('<video controls="">')
  })
})
