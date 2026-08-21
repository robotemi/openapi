temi OpenAPI
============

![temi](logo.svg)

RESTful API for controlling Temi robots in an organization.

For more information please see [the documentation][1].


Usage
--------

Authenticate every request with an Organization Access Token (OAT) in the `x-api-key` header.

OpenAPI control requires a **PRO** (or PRO free-trial) robot.

```
GET https://api.robotemi.com/openapi/v1/robots
x-api-key: <your-token>
```


Documentation
--------

* [API reference][1]
* [OpenAPI specification][2]
* [Developers][3]


License
-------

    Copyright 2026 temi USA inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.


[1]: https://openapi-docs.robotemi.com
[2]: temi-partner.openapi.yaml
[3]: https://www.robotemi.com/developers/
