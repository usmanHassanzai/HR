-- Employee company gifts: 85–90% × 3 months = movie tickets;
-- 95–100% × 1 month = dinner for 2; 95–100% × 6 months = surprise gift.

UPDATE public.kpi_award_config
SET movie_min_pct = 85,
    movie_max_pct = 90,
    movie_months = 3,
    movie_reward_name = '2 movie tickets',
    dinner_min_pct = 95,
    dinner_max_pct = 100,
    dinner_months = 1,
    dinner_reward_name = 'Dinner voucher for 2',
    gift_min_pct = 95,
    gift_max_pct = 100,
    gift_months = 6,
    gift_reward_name = 'Surprise gift from the company',
    updated_at = timezone('utc'::text, now());

NOTIFY pgrst, 'reload schema';
