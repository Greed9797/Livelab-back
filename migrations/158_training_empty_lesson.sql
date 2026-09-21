-- Migration 158 — the empty starter lesson does not count toward trail completion.
-- "Demonstração, prova e CTA" is seeded with source_kind 'none' and no source.
-- Keep the row visible. Stop requiring it until a source exists. Do not insert markdown.

UPDATE training_lessons
   SET required = false
 WHERE id = 'a1111111-1111-4111-8111-111111111134'
   AND source_kind = 'none'
   AND source_slug IS NULL
   AND source_title IS NULL
   AND title = 'Demonstração, prova e CTA';
