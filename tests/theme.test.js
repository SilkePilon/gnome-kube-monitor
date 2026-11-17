// Tests for the light/dark decision. Pure arithmetic: no St, no shell.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {relativeLuminance, styleVariant, verticalBoxParams} from '../lib/theme.js';

/** @param {number} red @param {number} green @param {number} blue */
function rgb(red, green, blue) {
    return {red, green, blue};
}

test('relative luminance spans black to white', () => {
    assert.equal(relativeLuminance(rgb(0, 0, 0)), 0);
    assert.equal(relativeLuminance(rgb(255, 255, 255)), 1);
});

test('the sRGB curve is linear near black and a power law above it', () => {
    // Either side of the 0.03928 knee, which a plain gamma would get wrong.
    assert.equal(relativeLuminance(rgb(5, 5, 5)).toFixed(5), (5 / 255 / 12.92).toFixed(5));
    assert.ok(relativeLuminance(rgb(128, 128, 128)) < 0.5, 'mid grey is not mid luminance');
});

test('green weighs more than red, and red more than blue', () => {
    assert.ok(relativeLuminance(rgb(0, 255, 0)) > relativeLuminance(rgb(255, 0, 0)));
    assert.ok(relativeLuminance(rgb(255, 0, 0)) > relativeLuminance(rgb(0, 0, 255)));
});

test('the shell stylesheets are recognised by the text colour they set', () => {
    // #222226 is gnome-shell-light.css, #ffffff both dark and high contrast.
    assert.equal(styleVariant(rgb(0x22, 0x22, 0x26)), 'light');
    assert.equal(styleVariant(rgb(0xff, 0xff, 0xff)), 'dark');
    assert.equal(styleVariant(rgb(0, 0, 0)), 'light');
});

test('a vertical box uses orientation from 48 and the old property before', () => {
    const VERTICAL = 1;
    // 51 removed the property outright: "No property vertical on StBoxLayout".
    assert.deepEqual(verticalBoxParams('51.1', VERTICAL), {orientation: VERTICAL});
    assert.deepEqual(verticalBoxParams('48.rc', VERTICAL), {orientation: VERTICAL});
    assert.deepEqual(verticalBoxParams('47.4', VERTICAL), {vertical: true});
    assert.deepEqual(verticalBoxParams('45.0', VERTICAL), {vertical: true});
});
