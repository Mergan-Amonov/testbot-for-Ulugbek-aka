-- Ochiq testlar: saytda guruhdan qat'i nazar hammaga ko'rinadi.
ALTER TABLE tests ADD COLUMN public INTEGER NOT NULL DEFAULT 0;

-- JPK (Jinoyat-protsessual kodeksi) testi — birinchi savoli bo'yicha topiladi
UPDATE tests SET public = 1 WHERE id IN (
    SELECT test_id FROM questions WHERE position = 0 AND text = 'Жиноят процессининг қисқача таърифини кўрсатинг.'
);
