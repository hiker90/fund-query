from datetime import datetime, timedelta
import urllib.parse

import akshare as ak
import pandas as pd

class FundApiService:
    def __init__(self):
        pass
    
    def get_fund_info(self, code):
        try:
            print(f"akshare版本: {ak.__version__}")
            
            fund_name = f'基金{code}'
            try:
                fund_name_df = ak.fund_name_em()
                if not fund_name_df.empty:
                    fund_row = fund_name_df[fund_name_df['基金代码'] == code]
                    if not fund_row.empty:
                        fund_name = fund_row['基金简称'].iloc[0]
                        print(f"获取基金名称: {fund_name}")
            except Exception as e:
                print(f"获取基金名称失败: {e}")
            
            fund_nav = ak.fund_open_fund_daily_em()
            fund_nav = fund_nav[fund_nav['基金代码'] == code]
            
            if fund_nav.empty:
                raise Exception("未获取到基金数据")
            
            net_worth = 1.0
            nav_date = datetime.now().strftime('%Y-%m-%d')
            day_growth = 0
            
            for col in fund_nav.columns:
                if '单位净值' in col:
                    net_worth = float(fund_nav[col].iloc[0])
                    nav_date = col.split('-单位净值')[0]
                    break
            
            if '日增长率' in fund_nav.columns:
                try:
                    day_growth_str = fund_nav['日增长率'].iloc[0]
                    day_growth = float(day_growth_str) / 100
                except:
                    day_growth = 0
            
            print(f"返回基金数据: {fund_name}, {net_worth}, {nav_date}")
            return {
                'code': code,
                'name': fund_name,
                'netWorth': net_worth,
                'dayGrowth': day_growth,
                'monthGrowth': 0,
                'yearGrowth': 0,
                'navDate': nav_date
            }
        except Exception as e:
            print(f"获取基金信息失败: {e}")
            raise
    
    def get_fund_history(self, code, days=90):
        try:
            fund_nav = ak.fund_open_fund_info_em(code)
            
            if fund_nav.empty:
                raise Exception("未获取到基金历史数据")
            
            fund_nav = fund_nav.sort_values('净值日期', ascending=True).tail(days)
            
            history_data = []
            
            for i in range(len(fund_nav)):
                nav_date = fund_nav['净值日期'].iloc[i].strftime('%Y-%m-%d')
                net_worth = float(fund_nav['单位净值'].iloc[i])
                history_data.append({
                    'date': nav_date,
                    'value': net_worth
                })
            
            print(f"返回历史数据共{len(history_data)}条")
            return history_data
        except Exception as e:
            print(f"获取基金历史走势失败: {e}")
            raise
    
    def get_fund_valuation(self, code):
        try:
            fund_info = self.get_fund_info(code)
            if not fund_info:
                return None
            
            return {
                'code': code,
                'name': fund_info['name'],
                'pe': 0,
                'pb': 0,
                'pePercentile': 0,
                'pbPercentile': 0,
                'roe': 0
            }
        except Exception as e:
            print(f"获取基金估值数据失败: {e}")
            return None
    
    def search_funds(self, keyword):
        try:
            print(f"akshare版本: {ak.__version__}")
            print(f"原始关键词: {keyword}")
            
            decoded_keyword = urllib.parse.unquote(keyword)
            print(f"解码后关键词: {decoded_keyword}")
            
            fund_list = ak.fund_name_em()
            if fund_list.empty:
                raise Exception("未获取到基金列表")
            
            print(f"获取到基金列表，共{len(fund_list)}条数据")
            
            filtered_funds = []
            if '基金简称' in fund_list.columns and '基金代码' in fund_list.columns:
                for _, row in fund_list.iterrows():
                    fund_name = str(row['基金简称'])
                    fund_code = str(row['基金代码'])
                    
                    if decoded_keyword in fund_name or decoded_keyword in fund_code:
                        filtered_funds.append(row)
                        print(f"匹配基金: {fund_code} - {fund_name}")
                
                print(f"过滤后基金数量: {len(filtered_funds)}")
            else:
                raise Exception("基金列表数据结构不符合预期")
            
            if len(filtered_funds) == 0:
                raise Exception("未找到匹配的基金")
            
            result = []
            for row in filtered_funds[:10]:
                fund_code = row['基金代码']
                try:
                    fund_info = self.get_fund_info(fund_code)
                    if fund_info:
                        result.append(fund_info)
                except Exception as e:
                    print(f"获取基金{fund_code}信息失败: {e}")
                    continue
            
            if len(result) == 0:
                raise Exception("未获取到匹配基金的详细信息")
            
            return result
        except Exception as e:
            print(f"搜索基金失败: {e}")
            raise

fund_api_service = FundApiService()
