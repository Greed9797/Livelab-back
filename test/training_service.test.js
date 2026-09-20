import { describe, expect, it } from 'vitest'
import {
  assembleHome,
  audienceForRole,
  continueTarget,
  freshness,
  hydrateLesson,
  nextLessonInTrail,
  nextRequiredLesson,
  orderTrailLessons,
  pickRecommended,
  resumePath,
  trailProgress,
} from '../src/services/training.js'

const trail = {
  id: 't1',
  slug: 'primeira-live-que-converte',
  title: 'Primeira Live que converte',
  outcome: 'Abrir a primeira live',
  audience_roles: ['apresentadora'],
  topics: ['live'],
  difficulty: 'iniciante',
  duration_minutes: 28,
  featured: true,
}
const modules = [
  { id: 'm1', trail_id: 't1', title: 'Preparação', sort_order: 1 },
  { id: 'm2', trail_id: 't1', title: 'Ao vivo', sort_order: 2 },
]
const lessons = [
  { id: 'l1', module_id: 'm1', sort_order: 1, required: true, title: 'Checklist', featured: true, audience_roles: ['apresentadora'], topics: ['live'], format: 'checklist' },
  { id: 'l2', module_id: 'm1', sort_order: 2, required: true, title: 'Oferta', featured: false, audience_roles: ['apresentadora', 'operacao'], topics: ['shop'], format: 'checklist' },
  { id: 'l3', module_id: 'm2', sort_order: 1, required: false, title: 'Extra', featured: false, audience_roles: ['gestor'], topics: ['politicas'], format: 'documento' },
]

describe('training P0 assembly', () => {
  it('maps papéis to a deterministic audience, never ML', () => {
    expect(audienceForRole('apresentadora')).toBe('apresentadora')
    expect(audienceForRole('produtor_live')).toBe('operacao')
    expect(audienceForRole('gerente_comercial')).toBe('comercial')
    expect(audienceForRole('franqueado')).toBe('gestor')
  })

  it('counts trail progress from required lessons only', () => {
    const progress = new Map([['l1', { completed_at: '2026-09-20T10:00:00Z' }], ['l3', { completed_at: '2026-09-20T10:00:00Z' }]])
    expect(trailProgress(lessons, progress)).toEqual({
      required_lessons: 2,
      completed_lessons: 1,
      progress_pct: 50,
    })
  })

  it('resumes the last open lesson or the next required one after complete', () => {
    const started = continueTarget({
      lessons,
      modules,
      trails: [trail],
      progressRows: [{ lesson_id: 'l1', last_opened_at: '2026-09-20T10:00:00Z', started_at: '2026-09-20T10:00:00Z' }],
    })
    expect(started.lesson.id).toBe('l1')
    expect(started.resume_path).toBe(resumePath(trail.slug, 'l1'))

    const afterComplete = continueTarget({
      lessons,
      modules,
      trails: [trail],
      progressRows: [{ lesson_id: 'l1', last_opened_at: '2026-09-20T11:00:00Z', completed_at: '2026-09-20T11:00:00Z' }],
    })
    expect(afterComplete.lesson.id).toBe('l2')
    expect(afterComplete.resume_path).toBe('/conhecimento/trilhas/primeira-live-que-converte/aulas/l2')
  })

  it('recommends unfinished lessons for the role and skips completed ones', () => {
    const progressByLesson = new Map([['l1', { completed_at: 'x' }]])
    const recommended = pickRecommended({ lessons, audience: 'apresentadora', progressByLesson })
    expect(recommended.map((lesson) => lesson.id)).toEqual(['l2'])
  })

  it('walks lessons by module then sort so complete does not skip aula 2', () => {
    expect(orderTrailLessons(lessons, modules, trail.id).map((lesson) => lesson.id)).toEqual(['l1', 'l2', 'l3'])
    expect(nextLessonInTrail(lessons, modules, lessons[0]).id).toBe('l2')
  })

  it('lets ?role= change recommended away from the JWT audience', () => {
    const gestorHome = assembleHome({
      papel: 'franqueado',
      trails: [trail],
      modules,
      lessons,
      progressRows: [],
      bookmarkIds: [],
      sources: { network: new Map(), unit: new Map() },
      curatedUpdates: [],
      derivedUpdates: [],
    })
    const filtered = assembleHome({
      papel: 'franqueado',
      trails: [trail],
      modules,
      lessons,
      progressRows: [],
      bookmarkIds: [],
      sources: { network: new Map(), unit: new Map() },
      curatedUpdates: [],
      derivedUpdates: [],
      filters: { role: 'apresentadora' },
    })
    expect(gestorHome.audience).toBe('gestor')
    expect(gestorHome.recommended.map((lesson) => lesson.id)).toEqual(['l3'])
    expect(filtered.recommended.map((lesson) => lesson.id)).toEqual(['l1', 'l2'])
  })

  it('copies video and markdown onto the lesson payload without inventing numbers', () => {
    const sources = {
      network: new Map([['slug-a', {
        id: 'art-1',
        slug: 'slug-a',
        titulo: 'Artigo',
        content_markdown: '# Corpo',
        video_provider: 'youtube',
        video_url: 'https://www.youtube.com/watch?v=abc_123',
        origin_kind: 'network_article',
      }]]),
      unit: new Map(),
    }
    const card = hydrateLesson(
      { id: 'l1', title: 'Checklist', source_kind: 'network_article', source_slug: 'slug-a', module_id: 'm1', sort_order: 1 },
      { sources, includeContent: true },
    )
    expect(card.content_markdown).toBe('# Corpo')
    expect(card.video_url).toBe('https://www.youtube.com/watch?v=abc_123')
    expect(card.material.video_url).toBe('https://www.youtube.com/watch?v=abc_123')
    expect(JSON.stringify(card)).not.toMatch(/"gmv"|valor_fixo|70/)
  })

  it('uses start-here when there is no history and continue when there is', () => {
    const empty = assembleHome({
      papel: 'apresentadora',
      trails: [trail],
      modules,
      lessons,
      progressRows: [],
      bookmarkIds: [],
      sources: { network: new Map(), unit: new Map() },
      curatedUpdates: [],
      derivedUpdates: [],
    })
    expect(empty.continue_learning).toBeNull()
    expect(empty.start_here.slug).toBe('primeira-live-que-converte')
    expect(empty.resume.has_started).toBe(false)
    expect(empty.resume.path).toContain('/conhecimento/trilhas/primeira-live-que-converte/aulas/')

    const resumed = assembleHome({
      papel: 'apresentadora',
      trails: [trail],
      modules,
      lessons,
      progressRows: [{ lesson_id: 'l1', started_at: 's', last_opened_at: 's' }],
      bookmarkIds: ['l1'],
      sources: { network: new Map(), unit: new Map() },
      curatedUpdates: [],
      derivedUpdates: [],
    })
    expect(resumed.start_here).toBeNull()
    expect(resumed.continue_learning.id).toBe('l1')
    expect(resumed.continue_learning.resume_path).toBe(resumePath(trail.slug, 'l1'))
    expect(resumed.resume.has_started).toBe(true)
  })

  it('labels freshness from dates and never invents Popular', () => {
    const now = new Date('2026-09-20T12:00:00Z')
    expect(freshness({ published_at: '2026-09-18T12:00:00Z' }, now)).toBe('novo')
    expect(freshness({ published_at: '2026-08-01T12:00:00Z', updated_at: '2026-09-19T12:00:00Z' }, now)).toBe('atualizado')
    expect(nextRequiredLesson(lessons, new Map()).id).toBe('l1')
  })
})
