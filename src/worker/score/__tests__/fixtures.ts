import sharp from 'sharp';

/** Reproducible synthetic illustration; not a calibration dataset. */
export async function illustration(seed = 7, cornerOnly = false): Promise<Buffer> {
    let state = seed >>> 0;
    function random() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    }
    const elements: string[] = [];
    for (let i = 0; i < 450; i++) {
        const x = 35 + Math.floor(random() * 560);
        const y = 35 + Math.floor(random() * 560);
        const size = 4 + Math.floor(random() * 25);
        const shade = Math.floor(random() * 190)
            .toString(16)
            .padStart(2, '0');
        if (i % 2)
            elements.push(
                `<circle cx="${x}" cy="${y}" r="${size}" fill="#${shade}${shade}${shade}"/>`,
            );
        else
            elements.push(
                `<path d="M${x} ${y} l${size} ${size * 2} l${size} ${-size} z" fill="#${shade}${shade}${shade}" stroke="black" stroke-width="2"/>`,
            );
    }
    const group = cornerOnly
        ? `<g transform="translate(10 10) scale(0.3)">${elements.join('')}</g>`
        : elements.join('');
    return sharp(
        Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="white"/>${group}</svg>`,
        ),
    )
        .png()
        .toBuffer();
}
