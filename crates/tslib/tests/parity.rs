//! JS-parity assertions for the `tslib` fidelity layer (series 027).

use tslib::{array, string};

#[test]
fn array_at_negative_indexes_from_end() {
    let xs = [10.0, 20.0, 30.0];
    assert_eq!(array::at(&xs, -1.0), 30.0);
    assert_eq!(array::at(&xs, -2.0), 20.0);
    assert_eq!(array::at(&xs, 0.0), 10.0);
    assert_eq!(array::at(&xs, 2.0), 30.0);
}

#[test]
#[should_panic]
fn array_at_out_of_range_panics() {
    let xs = [1.0, 2.0];
    array::at(&xs, -3.0);
}

#[test]
fn pad_start_matches_js() {
    assert_eq!(string::pad_start("5", 3.0, "0"), "005");
    assert_eq!(string::pad_start("abc", 2.0, "*"), "abc"); // already long enough
    assert_eq!(string::pad_start("7", 5.0, "ab"), "abab7"); // repeat + truncate
}

#[test]
fn pad_end_matches_js() {
    assert_eq!(string::pad_end("5", 3.0, "0"), "500");
    assert_eq!(string::pad_end("abc", 2.0, "*"), "abc");
    assert_eq!(string::pad_end("7", 5.0, "ab"), "7abab");
}
