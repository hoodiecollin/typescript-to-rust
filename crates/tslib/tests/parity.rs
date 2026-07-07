//! JS-parity assertions for the `tslib` fidelity layer (series 027).

use tslib::{array, json, string};

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
fn sort_default_is_lexicographic_string_order() {
    let mut xs = vec![10.0, 1.0, 2.0];
    array::sort_default(&mut xs);
    assert_eq!(xs, vec![1.0, 10.0, 2.0]); // the JS string-compare quirk
}

#[test]
fn sort_by_uses_the_comparator_sign() {
    let mut xs = vec![10.0, 1.0, 2.0];
    array::sort_by(&mut xs, |a, b| a - b);
    assert_eq!(xs, vec![1.0, 2.0, 10.0]); // numeric ascending
    array::sort_by(&mut xs, |a, b| b - a);
    assert_eq!(xs, vec![10.0, 2.0, 1.0]); // numeric descending
}

#[test]
fn slice_clamps_and_indexes_from_end() {
    let xs = [1.0, 2.0, 3.0, 4.0];
    assert_eq!(array::slice(&xs, 1.0, 3.0), vec![2.0, 3.0]);
    assert_eq!(array::slice(&xs, 1.0, 100.0), vec![2.0, 3.0, 4.0]); // end clamps
    assert_eq!(array::slice(&xs, 3.0, 1.0), Vec::<f64>::new()); // empty range
    assert_eq!(array::slice_from(&xs, -2.0), vec![3.0, 4.0]); // negative start
    assert_eq!(array::slice_from(&xs, 1.0), vec![2.0, 3.0, 4.0]);
}

#[test]
fn json_stringify_uses_js_number_formatting() {
    assert_eq!(json::stringify(&1.0_f64), "1"); // not "1.0"
    assert_eq!(json::stringify(&1.5_f64), "1.5");
    assert_eq!(json::stringify(&vec![1.0_f64, 2.0, 3.0]), "[1,2,3]");
    assert_eq!(json::stringify(&"hi"), "\"hi\"");
    assert_eq!(json::stringify(&true), "true");
}

#[test]
fn json_stringify_preserves_object_key_order() {
    let mut m: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    m.insert("b".to_string(), 2.0);
    m.insert("a".to_string(), 1.0);
    assert_eq!(json::stringify(&m), "{\"b\":2,\"a\":1}"); // insertion order
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
