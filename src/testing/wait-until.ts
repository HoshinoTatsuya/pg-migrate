/**
 * Ждать, пока условие станет истинным (опрос), но не дольше `limitMs`: условие
 * не наступило — отказ с текстом, а не таймаут jest без причины.
 */
export const waitUntil = async (
  what: string,
  check: () => Promise<boolean>,
  limitMs = 10_000,
): Promise<void> => {
  const attempts = Math.ceil(limitMs / 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`не дождались: ${what}`);
};
