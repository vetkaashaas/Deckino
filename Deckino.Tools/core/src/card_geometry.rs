//! CardGeometryService.cs: checks an annotated card outline and rectifies it for the preview.

use anyhow::{Result, bail};
use image::RgbaImage;

use crate::camera_annotation::NormalizedPoint;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeometryValidation {
    pub is_valid: bool,
    pub message: String,
}

pub struct CardGeometryService;

impl CardGeometryService {
    pub const PREVIEW_WIDTH: u32 = 315;
    pub const PREVIEW_HEIGHT: u32 = 440;

    pub fn validate(points: &[NormalizedPoint]) -> GeometryValidation {
        let invalid = |message: &str| GeometryValidation { is_valid: false, message: message.into() };
        if points.len() != 4 {
            return invalid("Add all four corners in order.");
        }
        if points.iter().any(|point| !(0.0..=1.0).contains(&point.x) || !(0.0..=1.0).contains(&point.y)) {
            return invalid("Every corner must remain inside the photograph.");
        }
        for first in 0..points.len() {
            for second in first + 1..points.len() {
                if distance_squared(points[first], points[second]) < 0.000025 {
                    return invalid("Two corners are too close together.");
                }
            }
        }

        let signs: Vec<f64> =
            (0..4).map(|index| cross(points[index], points[(index + 1) % 4], points[(index + 2) % 4])).collect();
        if signs.iter().any(|value| value.abs() < 0.0001)
            || !(signs.iter().all(|value| *value > 0.0) || signs.iter().all(|value| *value < 0.0))
        {
            return invalid("The ordered corners must form a convex, non-crossing card outline.");
        }

        let area = (0..4)
            .map(|index| {
                let (point, next) = (points[index], points[(index + 1) % 4]);
                point.x * next.y - next.x * point.y
            })
            .sum::<f64>()
            .abs()
            / 2.0;
        if area < 0.0025 {
            return invalid("The selected card area is too small.");
        }
        GeometryValidation { is_valid: true, message: "Geometry is valid and ready to save.".into() }
    }

    /// The card rectified to PREVIEW_WIDTH x PREVIEW_HEIGHT, bilinear-sampled. Fails with the validation message
    /// when the corners are not a valid outline.
    pub fn create_perspective_preview(image: &RgbaImage, points: &[NormalizedPoint]) -> Result<RgbaImage> {
        let validation = Self::validate(points);
        if !validation.is_valid {
            bail!(validation.message);
        }

        let (width, height) = image.dimensions();
        let pixel_corners: Vec<NormalizedPoint> = points
            .iter()
            .map(|point| NormalizedPoint::new(point.x * (width - 1) as f64, point.y * (height - 1) as f64))
            .collect();
        let (right, bottom) = ((Self::PREVIEW_WIDTH - 1) as f64, (Self::PREVIEW_HEIGHT - 1) as f64);
        let destination_corners = [
            NormalizedPoint::new(0.0, 0.0),
            NormalizedPoint::new(right, 0.0),
            NormalizedPoint::new(right, bottom),
            NormalizedPoint::new(0.0, bottom),
        ];
        let h = Self::solve_homography(&destination_corners, &pixel_corners)?;
        Ok(RgbaImage::from_fn(Self::PREVIEW_WIDTH, Self::PREVIEW_HEIGHT, |x, y| {
            let (x, y) = (x as f64, y as f64);
            let denominator = h[6] * x + h[7] * y + 1.0;
            let source_x = (h[0] * x + h[1] * y + h[2]) / denominator;
            let source_y = (h[3] * x + h[4] * y + h[5]) / denominator;
            sample_bilinear(image, source_x, source_y)
        }))
    }

    /// The 3x3 homography (h33 = 1) taking each `from` corner to its `to` corner, row-major, by Gauss-Jordan
    /// elimination with partial pivoting.
    pub fn solve_homography(from: &[NormalizedPoint], to: &[NormalizedPoint]) -> Result<[f64; 8]> {
        let mut matrix = [[0.0f64; 9]; 8];
        for index in 0..4 {
            let (x, y, u, v) = (from[index].x, from[index].y, to[index].x, to[index].y);
            let row = index * 2;
            matrix[row][0] = x;
            matrix[row][1] = y;
            matrix[row][2] = 1.0;
            matrix[row][6] = -u * x;
            matrix[row][7] = -u * y;
            matrix[row][8] = u;
            matrix[row + 1][3] = x;
            matrix[row + 1][4] = y;
            matrix[row + 1][5] = 1.0;
            matrix[row + 1][6] = -v * x;
            matrix[row + 1][7] = -v * y;
            matrix[row + 1][8] = v;
        }

        for pivot in 0..8 {
            // MaxBy keeps the first of equal rows.
            let mut best = pivot;
            for row in pivot + 1..8 {
                if matrix[row][pivot].abs() > matrix[best][pivot].abs() {
                    best = row;
                }
            }
            if matrix[best][pivot].abs() < 1e-10 {
                bail!("The corners cannot produce a perspective transform.");
            }
            matrix.swap(pivot, best);
            let divisor = matrix[pivot][pivot];
            for column in pivot..9 {
                matrix[pivot][column] /= divisor;
            }
            for row in 0..8 {
                if row == pivot {
                    continue;
                }
                let factor = matrix[row][pivot];
                for column in pivot..9 {
                    matrix[row][column] -= factor * matrix[pivot][column];
                }
            }
        }
        Ok(std::array::from_fn(|row| matrix[row][8]))
    }
}

fn sample_bilinear(source: &RgbaImage, x: f64, y: f64) -> image::Rgba<u8> {
    let (width, height) = source.dimensions();
    let x = x.clamp(0.0, (width - 1) as f64);
    let y = y.clamp(0.0, (height - 1) as f64);
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (x1, y1) = ((x0 + 1).min(width - 1), (y0 + 1).min(height - 1));
    let (x_weight, y_weight) = (x - x0 as f64, y - y0 as f64);
    let (p00, p10, p01, p11) =
        (source.get_pixel(x0, y0), source.get_pixel(x1, y0), source.get_pixel(x0, y1), source.get_pixel(x1, y1));
    image::Rgba(std::array::from_fn(|channel| {
        let top = p00[channel] as f64 * (1.0 - x_weight) + p10[channel] as f64 * x_weight;
        let bottom = p01[channel] as f64 * (1.0 - x_weight) + p11[channel] as f64 * x_weight;
        (top * (1.0 - y_weight) + bottom * y_weight).round_ties_even().clamp(0.0, 255.0) as u8
    }))
}

fn distance_squared(first: NormalizedPoint, second: NormalizedPoint) -> f64 {
    (first.x - second.x).powi(2) + (first.y - second.y).powi(2)
}

fn cross(a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint) -> f64 {
    (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
}
