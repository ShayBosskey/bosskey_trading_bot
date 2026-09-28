const { WyomingParser } = require('../src/PiperClient');

const frame = (header, data, payload) => {
    const dataBuf = data ? Buffer.from(JSON.stringify(data)) : Buffer.alloc(0);
    const payloadBuf = payload || Buffer.alloc(0);
    const h = { ...header };
    if (dataBuf.length) h.data_length = dataBuf.length;
    if (payloadBuf.length) h.payload_length = payloadBuf.length;
    return Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), dataBuf, payloadBuf]);
};

describe('WyomingParser', () => {
    test('parses separate data + binary payload, even when split byte-by-byte', () => {
        const pcm = Buffer.from([1, 2, 3, 4]);
        const stream = Buffer.concat([
            frame({ type: 'audio-start' }, { rate: 22050, width: 2, channels: 1 }),
            frame({ type: 'audio-chunk' }, { rate: 22050, width: 2, channels: 1 }, pcm),
            frame({ type: 'audio-stop' })
        ]);

        const parser = new WyomingParser();
        const events = [];
        for (const byte of stream) events.push(...parser.push(Buffer.from([byte])));

        expect(events.map((e) => e.type)).toEqual(['audio-start', 'audio-chunk', 'audio-stop']);
        expect(events[0].data).toEqual({ rate: 22050, width: 2, channels: 1 });
        expect(events[1].payload).toEqual(pcm);
        expect(events[2].payload).toBeNull();
    });

    test('accepts older servers that inline data in the header', () => {
        const events = new WyomingParser().push(Buffer.from(JSON.stringify({ type: 'audio-start', data: { rate: 16000, width: 2, channels: 1 } }) + '\n'));
        expect(events[0].data.rate).toBe(16000);
    });
});
