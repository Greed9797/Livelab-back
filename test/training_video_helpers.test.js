import { describe, expect, it } from 'vitest'
import { mergeWatchedIntervals, videoSource, watchedPercent } from '../src/services/training-progress.js'

describe('training video progress helpers', () => {
  it('unions skipped and replayed intervals without double counting', () => {
    const first = mergeWatchedIntervals([], [[0, 24], [48, 72]])
    const merged = mergeWatchedIntervals(first, [[20, 30], [48, 72], [72, 90]])
    expect(merged).toEqual([[0, 30], [48, 90]])
    expect(watchedPercent(merged, 100)).toBe(72)
  })

  it('accepts trusted provider URLs and emits a canonical safe embed URL', () => {
    expect(videoSource('youtube', 'https://youtu.be/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube', id: 'dQw4w9WgXcQ', libraryId: null,
      url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    })
    const pandaId = '99e352b8-5ec0-4ab4-91dc-f0177b468b10'
    expect(videoSource('panda', `https://player-123.tv.pandavideo.com.br/embed/?v=${pandaId}`)).toEqual({
      provider: 'panda', id: pandaId, libraryId: '123',
      url: `https://player-123.tv.pandavideo.com.br/embed/?v=${pandaId}`,
    })
  })

  it('rejects untrusted hosts, insecure URLs and malformed provider identifiers', () => {
    expect(videoSource('youtube', 'https://youtube.example/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(videoSource('youtube', 'http://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(videoSource('youtube', 'https://youtube.com.evil/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(videoSource('panda', 'https://player-123.tv.pandavideo.com.br.evil/embed/?v=99e352b8-5ec0-4ab4-91dc-f0177b468b10')).toBeNull()
  })
})
