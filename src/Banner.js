// SHEFA's startup banner for the PM2 logs of long-running services. Hardcoded
// ANSI truecolor, no figlet: zero dependencies and no work beyond one write.
//
// Printed once per process start, so it is wired into the long-lived services
// only (exit engine, dashboard API). The entry bot restarts every 15 minutes and
// would bury its own scan output under the art.
const ESC = '\x1b[';
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

// Royal Violet ramp: deep brand #7851A9 up to lavender, top to bottom.
const RAMP = [
    rgb(120, 81, 169),
    rgb(134, 96, 182),
    rgb(149, 112, 196),
    rgb(164, 129, 208),
    rgb(179, 157, 219),
    rgb(196, 173, 235),
];

const FACE = [
    '         .-~~~~~~~~-.        ',
    '       .\'  .~~~~~~.  \'.      ',
    '      /  .\'        \'.  \\     ',
    '     |  /   _    _   \\  |    ',
    '     | |   (◆)  (◆)   | |    ',
    '     | |       ʖ      | |    ',
    '     | |    \\____/    | |    ',
    '     |  \\            /  |    ',
    '    /|   \'-.______.-\'   |\\   ',
    '   / |      |    |      | \\  ',
];

const WORDMARK = [
    '███████╗██╗  ██╗███████╗███████╗ █████╗ ',
    '██╔════╝██║  ██║██╔════╝██╔════╝██╔══██╗',
    '███████╗███████║█████╗  █████╗  ███████║',
    '╚════██║██╔══██║██╔══╝  ██╔══╝  ██╔══██║',
    '███████║██║  ██║███████╗██║     ██║  ██║',
    '╚══════╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝',
];

function renderBanner(service, { color = true } = {}) {
    const c = s => (color ? s : '');
    const lines = [''];
    const height = Math.max(FACE.length, WORDMARK.length + 4);
    for (let i = 0; i < height; i++) {
        const face = FACE[i] || ' '.repeat(FACE[0].length);
        const tone = RAMP[Math.min(RAMP.length - 1, Math.floor(i / 2))];
        let right = '';
        const w = i - 1; // wordmark starts one row down so it sits mid-face
        if (w >= 0 && w < WORDMARK.length) right = c(BOLD + RAMP[w]) + WORDMARK[w] + c(RESET);
        else if (w === WORDMARK.length + 1) right = c(BOLD + RAMP[5]) + 'S H E F A   A I' + c(RESET) + c(DIM) + '  ·  autonomous trading intelligence' + c(RESET);
        else if (w === WORDMARK.length + 2) right = c(RAMP[4]) + 'Welcome, Sir Elkayam.' + c(RESET);
        lines.push(c(tone) + face + c(RESET) + '  ' + right);
    }
    lines.push(c(DIM + RAMP[3]) + `   ⟡ ${service} online · ${new Date().toISOString()}` + c(RESET), '');
    return lines.join('\n');
}

function printBanner(service) {
    // NO_COLOR is the cross-tool convention for "plain text, please".
    process.stdout.write(renderBanner(service, { color: !process.env.NO_COLOR }) + '\n');
}

module.exports = { printBanner, renderBanner };
