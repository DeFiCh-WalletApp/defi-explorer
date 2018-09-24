import { Injectable } from '@angular/core';
import { CurrencyProvider } from '../currency/currency';
import { ApiProvider } from '../api/api';
import 'rxjs/add/operator/map';

/*
  Generated class for the PriceProvider provider.

  See https://angular.io/docs/ts/latest/guide/dependency-injection.html
  for more info on providers and Angular DI.
*/
@Injectable()
export class PriceProvider {
  constructor(public currency: CurrencyProvider, public api: ApiProvider) {}

  public setCurrency(currency: string): void {
    this.currency.currencySymbol = currency;
    localStorage.setItem('insight-currency', currency);

    if (currency === 'USD') {
      this.api.http.get(this.api.getUrl() + '/currency').subscribe(
        data => {
          let currencyParsed: any = JSON.parse(data['_body']);
          if (currencyParsed.data.bitstamp) {
            this.currency.factor = this.currency.bitstamp = currencyParsed.data.bitstamp;
          } else if (currencyParsed.data.kraken) {
            this.currency.factor = this.currency.kraken = currencyParsed.data.kraken;
          }
          this.currency.loading = false;
        },
        err => {
          this.currency.loading = false;
          console.error('err getting currency', err);
        }
      );
    } else if (currency === 'm' + this.api.networkSettings.value.selectedNetwork.chain) {
      this.currency.factor = 1000;
    } else {
      this.currency.factor = 1;
    }
  }
}
