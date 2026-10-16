# limits-countdown

Мод для Claude Code: строка над полем ввода, где видно, сколько осталось до сброса лимитов, сколько занято контекста, и кнопка, которая его сжимает.

```
Сессия: 8%, сброс через 2 ч 54 мин   Неделя: 5%, сброс через 3 д 5 ч        Контекст: 12% (120k из 1M)  [Сжать]
```

- **Слева лимиты.** Вместо «Resets Tue 3:00 AM» видно, сколько осталось до сброса. Обновляется раз в 30 секунд, а новая переписка сразу показывает последнее известное значение.
- **Справа контекст.** Сколько процентов окна занято и сколько это токенов. Сразу после сжатия до следующего ответа показывает примерный размер: `≈3% … после сжатия`.
- **Кнопка «Сжать»** делает то же самое, что `/compact`. Сначала она спрашивает «Сжать контекст? [Да] [Нет]», а пока Claude отвечает, её не видно.

Работает в терминале и в приложении Claude Desktop (вкладка Code). Нужен свежий Claude Code с поддержкой модов (проверено на 2.1.299).

## Установка

В поле ввода Claude Code:

```
/plugin install limits-countdown --marketplace ntilte/claude-limits-countdown
```

Claude спросит, добавить ли маркетплейс (ответь `y`), затем область установки (для себя — `user`). После этого перезапусти Claude.

Из командной строки:

```
claude plugin install limits-countdown --marketplace ntilte/claude-limits-countdown
```

Обновить: `claude plugin update limits-countdown@ntd-local`. Удалить: `claude plugin uninstall limits-countdown@ntd-local`.

## Разработка

- `hooks/format.ts` — тексты строки.
- `hooks/register.tsx` — хуки и кнопки.
- `tests/countdown.test.tsx` — тесты.

Проверка: `claude plugin validate .` и `claude plugin test .`.

---

**English.** A Claude Code mod that adds a bold row above the prompt with time left until the session and weekly limits reset, the context window fill, and a "Сжать" (compact) button with a confirmation step. The UI text is Russian. Install with `/plugin install limits-countdown --marketplace ntilte/claude-limits-countdown`.
