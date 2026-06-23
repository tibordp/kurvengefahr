//! Typesetter: glyphs (normalised em) → strokes (element-local mm). Pure procedural
//! geometry — line-breaking, scale-to-mm, baseline, slant, alignment. This is where a
//! convincing *page* is won; it has nothing to do with the model, so it stays a separate
//! module even though both now live in Rust.

use crate::geom::{Point, Stroke};
use crate::stroke_model::{Glyph, ASCENDER, SPACE_ADVANCE};

pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Align::Center,
            2 => Align::Right,
            _ => Align::Left,
        }
    }
}

pub struct Layout {
    pub font_size_mm: f32,
    pub line_height_em: f32,
    pub max_width_mm: f32,
    pub align: Align,
    pub slant_deg: f32,
}

/// A word is the glyph indices it spans plus its advance width (mm).
struct Word {
    glyphs: Vec<usize>,
    width: f32,
}

pub fn typeset(glyphs: &[Glyph], layout: &Layout) -> Vec<Stroke> {
    let fs = layout.font_size_mm;
    let space_w = SPACE_ADVANCE * fs;
    let tan = layout.slant_deg.to_radians().tan();

    // Split into paragraphs (on '\n') of words (on spaces).
    let mut paragraphs: Vec<Vec<Word>> = vec![Vec::new()];
    let mut cur = Word {
        glyphs: Vec::new(),
        width: 0.0,
    };
    let flush = |cur: &mut Word, paragraphs: &mut Vec<Vec<Word>>| {
        if !cur.glyphs.is_empty() {
            let done = std::mem::replace(
                cur,
                Word {
                    glyphs: Vec::new(),
                    width: 0.0,
                },
            );
            paragraphs.last_mut().unwrap().push(done);
        }
    };
    for (i, g) in glyphs.iter().enumerate() {
        match g.ch {
            '\n' => {
                flush(&mut cur, &mut paragraphs);
                paragraphs.push(Vec::new());
            }
            ' ' | '\t' => flush(&mut cur, &mut paragraphs),
            _ => {
                cur.glyphs.push(i);
                cur.width += g.advance * fs;
            }
        }
    }
    flush(&mut cur, &mut paragraphs);

    // Greedy word-wrap each paragraph into visual lines.
    let mut visual: Vec<Vec<Word>> = Vec::new();
    for para in paragraphs {
        let mut line: Vec<Word> = Vec::new();
        let mut line_w = 0.0f32;
        for w in para {
            let add = if line.is_empty() { 0.0 } else { space_w } + w.width;
            if !line.is_empty() && line_w + add > layout.max_width_mm {
                visual.push(std::mem::take(&mut line));
                line_w = w.width;
                line.push(w);
            } else {
                line_w += add;
                line.push(w);
            }
        }
        visual.push(line); // keep empty lines (blank paragraphs) for vertical rhythm
    }

    // Position glyphs.
    let mut strokes = Vec::new();
    let line_advance = layout.line_height_em * fs;
    for (line_index, line) in visual.iter().enumerate() {
        let line_width: f32 = line.iter().map(|w| w.width).sum::<f32>()
            + line.len().saturating_sub(1) as f32 * space_w;
        let mut pen_x = align_offset(&layout.align, line_width, layout.max_width_mm);
        let baseline_y = line_advance * line_index as f32 + ASCENDER * fs;

        for (wi, w) in line.iter().enumerate() {
            for &gi in &w.glyphs {
                let g = &glyphs[gi];
                for ns in &g.strokes {
                    let points: Vec<Point> = ns
                        .iter()
                        .map(|p| {
                            let up_mm = p.y * fs; // em (up positive) → mm
                            Point {
                                x: pen_x + p.x * fs + tan * up_mm, // slant shears by height
                                y: baseline_y - up_mm,
                                pressure: p.pressure,
                            }
                        })
                        .collect();
                    strokes.push(Stroke {
                        points,
                        pen: 0,
                        // Direction is free until TS decides (locked element → fixed). Grouping
                        // is assigned at element concatenation, so generators emit group 0.
                        reversible: true,
                        group: 0,
                    });
                }
                pen_x += g.advance * fs;
            }
            if wi + 1 < line.len() {
                pen_x += space_w;
            }
        }
    }

    strokes
}

fn align_offset(align: &Align, line_width: f32, max_width: f32) -> f32 {
    match align {
        Align::Center => (max_width - line_width) / 2.0,
        Align::Right => max_width - line_width,
        Align::Left => 0.0,
    }
}
