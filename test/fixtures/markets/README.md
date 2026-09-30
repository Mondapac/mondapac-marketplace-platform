# test/fixtures/markets

`ZZ` is a synthetic second Market used only by tests (ADR-0003 decision 9). It differs from
the launch Market on purpose: another locale, another time zone and a currency with no minor
unit, so code that quietly assumes the launch Market fails the test suite. Tests load this
directory together with `config/markets/`.
